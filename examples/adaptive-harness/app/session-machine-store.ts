/**
 * Durable XState lifecycle on top of the hash-chained SessionStore journal
 * (DEEP_STATE_PLAN v1). One journal is the authority; checkpoints are a cache.
 * No parallel store, no always-resident actors: restore -> apply -> settle ->
 * checkpoint, all inside the caller's SessionStore.withSession lock.
 */
import { createActor } from "xstate";
import {
  conversationMachine,
  callKeyFor,
  CONVERSATION_MACHINE_ID,
  HOST_EVENT_TYPES,
  MACHINE_VERSION,
  type ConversationEvent,
} from "./conversation.machine.js";
import type {
  MachineCheckpoint,
  SessionState,
  SessionStore,
  StoredEvent,
} from "./session-store.js";

export class MachineTransitionError extends Error {
  status = 409;
}
export class MachineConflictError extends Error {
  status = 409;
}
export class MachineVersionError extends Error {
  status = 422;
}
export class MachineMigrationError extends Error {
  status = 422;
}

export type CallOutcome = "initiated" | "completed" | "failed";
export type CallRecord = {
  callKey: string;
  messageId: string;
  operation: string;
  outcome: CallOutcome;
};

export type SessionMachineRecord = {
  sessionId: string;
  machineId: string;
  machineVersion: string;
  revision: number;
  lastAppliedSeq: number;
  journalEventCount: number;
  journalHash: string | null;
  value: string;
  status: string;
  pendingFeedback: { messageId: string; reason: string } | null;
  pendingCall: CallRecord | null;
  calls: CallRecord[];
  reconciliationNeeded: boolean;
  migrated: boolean;
  checkpointUsed: boolean;
  checkpointDiscarded: boolean;
  lastCheckpointAt: string | null;
  createdAt: string;
};

type Actor = ReturnType<typeof createActor<typeof conversationMachine>>;

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object";

function snapshotValue(actor: Actor): string {
  const value = actor.getSnapshot().value;
  if (typeof value === "string") return value;
  if (isRecord(value)) return Object.keys(value)[0] ?? "unknown";
  return "unknown";
}

function canSend(actor: Actor, event: ConversationEvent): boolean {
  const snapshot = actor.getSnapshot() as unknown as {
    can?: (e: ConversationEvent) => boolean;
  };
  if (typeof snapshot.can === "function") return snapshot.can(event);
  return true;
}

function deriveCalls(state: SessionState): CallRecord[] {
  const calls: CallRecord[] = [];
  for (const record of state.machineEvents) {
    const event = record.event;
    if (event.type === "CALL_INITIATED") {
      const callKey = typeof event.callKey === "string" ? event.callKey : record.callKey;
      const messageId = typeof event.messageId === "string" ? event.messageId : record.messageId;
      if (callKey && messageId)
        calls.push({ callKey, messageId, operation: "luna", outcome: "initiated" });
    } else if (event.type === "MODEL_RESPONSE") {
      const open = [...calls].reverse().find((c) => c.outcome === "initiated");
      if (open) open.outcome = "completed";
    } else if (event.type === "CALL_FAILED") {
      const callKey = typeof event.callKey === "string" ? event.callKey : record.callKey;
      const target = [...calls]
        .reverse()
        .find((c) => c.callKey === callKey && c.outcome === "initiated");
      if (target) target.outcome = "failed";
    }
  }
  return calls;
}

/**
 * Pure legacy (v1 journal: no machine.event entries) migration seed.
 * completed latest turn -> awaitingMessage; pending feedback -> blocked;
 * incomplete user message without assistant output -> interrupted;
 * unknown shape -> MachineMigrationError. Never auto-regenerates.
 */
export function migrateLegacySessionV1(state: SessionState): {
  value: string;
  context: Record<string, unknown>;
} {
  for (const message of state.messages) {
    if (message.role !== "user" && message.role !== "assistant")
      throw new MachineMigrationError("Legacy journal contains an unknown message role");
    if (typeof message.messageId !== "string" || typeof message.text !== "string")
      throw new MachineMigrationError("Legacy journal contains a malformed message");
  }
  for (const feedback of state.feedback) {
    if (!["pending", "dismissed", "filed"].includes(feedback.status))
      throw new MachineMigrationError("Legacy journal contains an unknown feedback status");
  }
  const behavior = state.behavior;
  const base: Record<string, unknown> = {
    messages: state.messages.map((m) => ({
      messageId: m.messageId,
      text: m.text,
      role: m.role,
    })),
    selectedBehavior: behavior?.behaviorId ?? null,
    activeBehaviorId: behavior?.behaviorId ?? null,
    activeGoal: behavior?.goal ?? null,
    activePhase: behavior?.phase ?? null,
  };
  const pending = state.feedback.find((item) => item.status === "pending");
  if (pending) {
    return {
      value: "blocked",
      context: {
        ...base,
        lastMessageId: pending.messageId,
        pendingMessageId: pending.messageId,
        pendingFeedback: {
          messageId: pending.messageId,
          reason: pending.reason,
          ...(pending.signal ? { signal: pending.signal } : {}),
          ...(pending.category ? { category: pending.category } : {}),
        },
        blockedReason: pending.reason,
      },
    };
  }
  const lastUser = [...state.messages].reverse().find((m) => m.role === "user");
  if (lastUser && !state.messages.some((m) => m.messageId === `assistant-${lastUser.messageId}`)) {
    return {
      value: "interrupted",
      context: {
        ...base,
        lastMessageId: lastUser.messageId,
        pendingMessageId: lastUser.messageId,
        interruptedReason: "Legacy session ended with an incomplete turn",
      },
    };
  }
  return {
    value: "awaitingMessage",
    context: {
      ...base,
      lastMessageId: lastUser?.messageId ?? null,
    },
  };
}

function actorFromPersisted(sessionId: string, snapshot: unknown): Actor | null {
  if (!isRecord(snapshot)) return null;
  const context = (snapshot as { context?: unknown }).context;
  if (!isRecord(context) || context.sessionId !== sessionId) return null;
  const value = (snapshot as { value?: unknown }).value;
  if (typeof value !== "string" && !isRecord(value)) return null;
  try {
    const actor = createActor(conversationMachine, {
      snapshot: snapshot as never,
    }) as unknown as Actor;
    actor.start();
    if (actor.getSnapshot().context.sessionId !== sessionId) return null;
    return actor;
  } catch {
    return null;
  }
}

function replayEvents(actor: Actor, events: SessionState["machineEvents"]): void {
  for (const record of events) {
    const event = record.event as unknown as ConversationEvent;
    if (!(HOST_EVENT_TYPES as readonly string[]).includes(event.type))
      throw new MachineVersionError(`Unknown journal machine event: ${String(event.type)}`);
    if (!canSend(actor, event))
      throw new MachineTransitionError(
        `Journal machine event ${event.type} is not legal during replay`,
      );
    actor.send(event);
  }
}

export class RestoredMachine {
  readonly sessionId: string;
  private revision: number;
  private lastState: SessionState;
  readonly migrated: boolean;
  readonly checkpointUsed: boolean;
  readonly checkpointDiscarded: boolean;

  constructor(
    private readonly store: SessionStore,
    readonly actor: Actor,
    state: SessionState,
    flags: { migrated: boolean; checkpointUsed: boolean; checkpointDiscarded: boolean },
  ) {
    this.sessionId = state.sessionId;
    this.lastState = state;
    this.revision = state.machineEvents.length;
    this.migrated = flags.migrated;
    this.checkpointUsed = flags.checkpointUsed;
    this.checkpointDiscarded = flags.checkpointDiscarded;
  }

  get state(): SessionState {
    return this.lastState;
  }

  get value(): string {
    return snapshotValue(this.actor);
  }

  get context() {
    return this.actor.getSnapshot().context;
  }

  /** An initiated call with no completion/failure recorded after it. */
  get pendingCall(): CallRecord | null {
    return deriveCalls(this.lastState).find((c) => c.outcome === "initiated") ?? null;
  }

  get record(): SessionMachineRecord {
    const context = this.context;
    const pendingCall = this.pendingCall;
    const value = this.value;
    const status = pendingCall ? "interrupted" : value;
    return {
      sessionId: this.sessionId,
      machineId: CONVERSATION_MACHINE_ID,
      machineVersion: MACHINE_VERSION,
      revision: this.revision,
      lastAppliedSeq: this.lastState.eventCount - 1,
      journalEventCount: this.lastState.eventCount,
      journalHash: this.lastState.lastHash,
      value,
      status,
      pendingFeedback: context.pendingFeedback
        ? { messageId: context.pendingFeedback.messageId, reason: context.pendingFeedback.reason }
        : null,
      pendingCall,
      calls: deriveCalls(this.lastState),
      reconciliationNeeded: Boolean(pendingCall),
      migrated: this.migrated,
      checkpointUsed: this.checkpointUsed,
      checkpointDiscarded: this.checkpointDiscarded,
      lastCheckpointAt: this.lastState.checkpoint?.createdAt ?? null,
      createdAt: this.lastState.createdAt,
    };
  }

  /**
   * Validate + send + journal one host event, in order. The caller must hold
   * the SessionStore session lock (server processMessage does).
   */
  async apply(
    event: ConversationEvent,
    options: { expectedRevision?: number } = {},
  ): Promise<SessionMachineRecord> {
    // Re-read the journal first: if another instance advanced the machine
    // revision since this actor was restored, this actor is stale and must
    // not apply anything (a re-restore is required), whatever the caller
    // expected.
    const fresh = await this.store.load(this.sessionId);
    if (!fresh) throw new Error("Session does not exist");
    const journalRevision = fresh.machineEvents.length;
    if (journalRevision !== this.revision)
      throw new MachineConflictError(
        `Stale machine revision: journal at ${journalRevision}, restored actor at ${this.revision}; re-restore required`,
      );
    this.lastState = fresh;
    if (options.expectedRevision !== undefined && options.expectedRevision !== journalRevision)
      throw new MachineConflictError(
        `Stale machine revision: expected ${options.expectedRevision}, current ${journalRevision}`,
      );
    if (!(HOST_EVENT_TYPES as readonly string[]).includes(event.type))
      throw new MachineTransitionError(`Unknown host event: ${String(event.type)}`);
    if (!canSend(this.actor, event))
      throw new MachineTransitionError(`Event ${event.type} is not legal in state ${this.value}`);
    this.actor.send(event);
    const messageId =
      "messageId" in event
        ? (event as { messageId?: string }).messageId
        : "feedback" in event
          ? (event as { feedback?: { messageId?: string } }).feedback?.messageId
          : undefined;
    const callKey = "callKey" in event ? (event as { callKey?: string }).callKey : undefined;
    const eventId = `${this.sessionId}:${this.revision + 1}:${event.type}:${messageId ?? "turn"}`;
    this.lastState = await this.store.appendUnlocked(this.sessionId, [
      {
        type: "machine.event",
        record: {
          eventId,
          ...(messageId ? { messageId } : {}),
          ...(callKey ? { callKey } : {}),
          event: event as unknown as { type: string; [key: string]: unknown },
          recordedAt: new Date().toISOString(),
        },
      },
    ]);
    this.revision = this.lastState.machineEvents.length;
    return this.record;
  }

  /** Persist a snapshot cache at a quiescent boundary only. */
  async checkpoint(): Promise<SessionMachineRecord> {
    const value = this.value;
    if (!["awaitingMessage", "blocked", "interrupted"].includes(value))
      throw new MachineTransitionError(`Refusing to checkpoint in non-quiescent state ${value}`);
    const snapshot = this.actor.getPersistedSnapshot();
    // JSON-only envelope: a snapshot that does not survive a JSON round trip
    // is never written (no executable clients, secrets or live objects).
    const jsonSnapshot: unknown = JSON.parse(JSON.stringify(snapshot));
    const checkpoint: MachineCheckpoint = {
      machineId: CONVERSATION_MACHINE_ID,
      machineVersion: MACHINE_VERSION,
      revision: this.revision,
      anchorSeq: this.lastState.eventCount - 1,
      anchorHash: this.lastState.lastHash,
      snapshot: jsonSnapshot,
      createdAt: new Date().toISOString(),
    };
    this.lastState = await this.store.appendUnlocked(this.sessionId, [
      { type: "machine.checkpoint", checkpoint },
    ]);
    return this.record;
  }

  /** Adopt semantic writes appended directly through SessionStore. */
  async refresh(): Promise<SessionState> {
    const loaded = await this.store.load(this.sessionId);
    if (!loaded) throw new Error("Session does not exist");
    this.lastState = loaded;
    this.revision = loaded.machineEvents.length;
    return loaded;
  }

  async adopt(state: SessionState): Promise<void> {
    this.lastState = state;
    this.revision = state.machineEvents.length;
  }
}

export class SessionMachineStore {
  constructor(private readonly store: SessionStore) {}

  /**
   * Verify the journal (hash chain, via SessionStore.loadJournal), then
   * restore: valid checkpoint -> replay of later events; otherwise full
   * replay; legacy journals (no machine events) -> deterministic migration.
   * A corrupt journal fails closed (the load itself throws).
   */
  async restore(sessionId: string): Promise<RestoredMachine> {
    const journal = await this.store.loadJournal(sessionId);
    if (!journal) throw new Error("Session does not exist");
    const { state, entries } = journal;
    let checkpointUsed = false;
    let checkpointDiscarded = false;
    let migrated = false;
    let actor: Actor | null = null;

    const checkpoint = state.checkpoint;
    if (checkpoint) {
      const seqByEventId = new Map<string, number>();
      for (const entry of entries) {
        if (entry.event.type === "machine.event")
          seqByEventId.set(entry.event.record.eventId, entry.seq);
      }
      const machineEventsToAnchor = state.machineEvents.filter(
        (record) => (seqByEventId.get(record.eventId) ?? -1) <= checkpoint.anchorSeq,
      );
      const versionOk =
        checkpoint.machineId === CONVERSATION_MACHINE_ID &&
        checkpoint.machineVersion === MACHINE_VERSION;
      const anchorEntry = entries[checkpoint.anchorSeq];
      const anchorOk =
        anchorEntry !== undefined &&
        anchorEntry.hash === checkpoint.anchorHash &&
        checkpoint.revision === machineEventsToAnchor.length;
      if (versionOk && anchorOk) {
        actor = actorFromPersisted(sessionId, checkpoint.snapshot);
        if (actor) {
          checkpointUsed = true;
          const later = state.machineEvents.filter(
            (record) => (seqByEventId.get(record.eventId) ?? -1) > checkpoint.anchorSeq,
          );
          replayEvents(actor, later);
        } else {
          checkpointDiscarded = true;
        }
      } else if (state.machineEvents.length > 0) {
        // Mismatched/foreign checkpoint with a replayable journal: rebuild.
        checkpointDiscarded = true;
      } else {
        throw new MachineVersionError(
          `Checkpoint machine version ${checkpoint.machineVersion} cannot be migrated and the journal has no machine events to replay`,
        );
      }
    }

    if (!actor) {
      if (state.machineEvents.length > 0) {
        actor = createActor(conversationMachine, {
          input: { sessionId },
        }) as unknown as Actor;
        actor.start();
        replayEvents(actor, state.machineEvents);
      } else if (state.eventCount <= 1 && state.messages.length === 0) {
        actor = createActor(conversationMachine, {
          input: { sessionId },
        }) as unknown as Actor;
        actor.start();
      } else {
        // Legacy v1 journal: deterministic migration seed, never a guess at
        // unfinished actions and never auto-regeneration.
        const seed = migrateLegacySessionV1(state);
        const fresh = createActor(conversationMachine, {
          input: { sessionId },
        }) as unknown as Actor;
        fresh.start();
        const persisted = fresh.getPersistedSnapshot() as unknown as Record<string, unknown>;
        persisted.value = seed.value;
        persisted.context = {
          ...(persisted.context as Record<string, unknown>),
          ...seed.context,
          sessionId,
          machineVersion: MACHINE_VERSION,
        };
        actor = actorFromPersisted(sessionId, persisted);
        if (!actor || snapshotValue(actor) !== seed.value)
          throw new MachineMigrationError("Legacy migration did not produce the seeded state");
        migrated = true;
      }
    }

    return new RestoredMachine(this.store, actor, state, {
      migrated,
      checkpointUsed,
      checkpointDiscarded,
    });
  }
}

export { callKeyFor };
export type { StoredEvent };
