import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TemperCapabilityTrace, TurnTrace } from "./activity.js";
import type { BehaviorSelection } from "./behavior-composer.js";

export type SessionMessage = {
  messageId: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
};

export type SessionFeedback = {
  messageId: string;
  status: "pending" | "dismissed" | "filed";
  reason: string;
  category?: string;
  caseRef?: string;
  signal?: string;
  createdAt: string;
};

export type SessionEvent =
  | { type: "session.created"; sessionId: string; createdAt: string }
  | { type: "message.user"; message: SessionMessage }
  | { type: "message.assistant"; message: SessionMessage }
  | { type: "feedback.updated"; feedback: SessionFeedback }
  | { type: "turn.trace"; trace: TurnTrace }
  | { type: "temper.trace"; trace: TemperCapabilityTrace }
  | { type: "behavior.selected"; selection: BehaviorSelection };

type StoredEvent = {
  schemaVersion: 1;
  seq: number;
  event: SessionEvent;
  previousHash: string | null;
  hash: string;
};

export type SessionState = {
  sessionId: string;
  createdAt: string;
  messages: SessionMessage[];
  feedback: SessionFeedback[];
  traces: TurnTrace[];
  temperTraces: TemperCapabilityTrace[];
  behavior: BehaviorSelection | null;
  eventCount: number;
  lastHash: string | null;
};

const safeId = (id: string) => encodeURIComponent(id);
const eventPath = (directory: string, sessionId: string) =>
  join(directory, `${safeId(sessionId)}.jsonl`);
const hashEvent = (entry: Omit<StoredEvent, "hash">) =>
  createHash("sha256").update(JSON.stringify(entry)).digest("hex");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object";

function validateEvent(value: unknown): asserts value is StoredEvent {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Number.isInteger(value.seq)) {
    throw new Error("Invalid session event envelope");
  }
  if (!isRecord(value.event) || typeof value.event.type !== "string") {
    throw new Error("Invalid session event payload");
  }
  if (
    typeof value.hash !== "string" ||
    (value.previousHash !== null && typeof value.previousHash !== "string")
  ) {
    throw new Error("Invalid session event hash");
  }
  const { hash: _hash, ...withoutHash } = value;
  if (hashEvent(withoutHash as Omit<StoredEvent, "hash">) !== value.hash) {
    throw new Error("Session event hash mismatch");
  }
}

function applyEvent(state: SessionState, event: SessionEvent): SessionState {
  if (event.type === "session.created") {
    if (state.sessionId && state.sessionId !== event.sessionId)
      throw new Error("Session id mismatch");
    return { ...state, sessionId: event.sessionId, createdAt: event.createdAt };
  }
  if (event.type === "message.user" || event.type === "message.assistant") {
    if (state.messages.some((message) => message.messageId === event.message.messageId)) {
      const existing = state.messages.find(
        (message) => message.messageId === event.message.messageId,
      );
      if (existing?.role !== event.message.role || existing.text !== event.message.text) {
        throw new Error("Message id reused with different content");
      }
      return state;
    }
    return { ...state, messages: [...state.messages, event.message] };
  }
  if (event.type === "behavior.selected") {
    const selected = event.selection;
    if (
      !selected ||
      typeof selected.messageId !== "string" ||
      !["continue-work", "revise-work", "verification", "status-check", "conversation"].includes(
        selected.behaviorId,
      )
    )
      throw new Error("Invalid behavior selection");
    return { ...state, behavior: selected };
  }
  if (event.type === "turn.trace") {
    // Traces never contain model prompts, completions, secrets or raw error strings.
    const trace = event.trace;
    if (!trace || typeof trace.messageId !== "string" || !Array.isArray(trace.steps))
      throw new Error("Invalid turn trace");
    return { ...state, traces: [...state.traces, trace].slice(-30) };
  }
  if (event.type === "temper.trace") {
    const trace = event.trace;
    if (
      !trace ||
      typeof trace.capability !== "string" ||
      typeof trace.tenant !== "string" ||
      typeof trace.state !== "string" ||
      typeof trace.correlationId !== "string" ||
      typeof trace.durationMs !== "number" ||
      !Array.isArray(trace.steps)
    ) {
      throw new Error("Invalid Temper capability trace");
    }
    return { ...state, temperTraces: [...state.temperTraces, trace].slice(-30) };
  }
  if (event.type === "feedback.updated") {
    const existing = state.feedback.find((item) => item.messageId === event.feedback.messageId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(event.feedback)) {
      if (
        existing.status !== "pending" ||
        !["dismissed", "filed"].includes(event.feedback.status)
      ) {
        throw new Error("Feedback disposition changed outside an append-only transition");
      }
      return {
        ...state,
        feedback: state.feedback.map((item) =>
          item.messageId === event.feedback.messageId ? event.feedback : item,
        ),
      };
    }
    return existing ? state : { ...state, feedback: [...state.feedback, event.feedback] };
  }
  return state;
}

function emptyState(sessionId = ""): SessionState {
  return {
    sessionId,
    createdAt: "",
    messages: [],
    feedback: [],
    traces: [],
    temperTraces: [],
    behavior: null,
    eventCount: 0,
    lastHash: null,
  };
}

export class SessionStore {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly directory: string) {}

  async withSession<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(sessionId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(sessionId) === current) this.locks.delete(sessionId);
    }
  }

  async load(sessionId: string): Promise<SessionState | undefined> {
    let raw: string;
    try {
      raw = await readFile(eventPath(this.directory, sessionId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const state = emptyState(sessionId);
    let expectedSeq = 0;
    let previousHash: string | null = null;
    for (const line of raw.split("\n").filter(Boolean)) {
      const parsed: unknown = JSON.parse(line);
      validateEvent(parsed);
      if (parsed.seq !== expectedSeq || parsed.previousHash !== previousHash) {
        throw new Error("Session event sequence is not contiguous");
      }
      Object.assign(state, applyEvent(state, parsed.event));
      expectedSeq += 1;
      previousHash = parsed.hash;
    }
    if (!state.sessionId || expectedSeq === 0)
      throw new Error("Empty or invalid session event log");
    state.eventCount = expectedSeq;
    state.lastHash = previousHash;
    return state;
  }

  async create(sessionId: string = randomUUID()): Promise<SessionState> {
    return this.withSession(sessionId, async () => {
      if (await this.load(sessionId)) throw new Error("Session already exists");
      const createdAt = new Date().toISOString();
      const event: SessionEvent = { type: "session.created", sessionId, createdAt };
      const withoutHash: Omit<StoredEvent, "hash"> = {
        schemaVersion: 1,
        seq: 0,
        event,
        previousHash: null,
      };
      const entry: StoredEvent = { ...withoutHash, hash: hashEvent(withoutHash) };
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(eventPath(this.directory, sessionId), `${JSON.stringify(entry)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      return (await this.load(sessionId))!;
    });
  }

  async append(sessionId: string, events: SessionEvent[]): Promise<SessionState> {
    return this.withSession(sessionId, () => this.appendUnlocked(sessionId, events));
  }

  async appendUnlocked(sessionId: string, events: SessionEvent[]): Promise<SessionState> {
    if (events.length === 0) return (await this.load(sessionId)) ?? (await this.create(sessionId));
    const state = await this.load(sessionId);
    if (!state) throw new Error("Session does not exist");
    let nextState = state;
    const stored: StoredEvent[] = [];
    for (const event of events) {
      if (
        event.type !== "session.created" &&
        event.type !== "message.user" &&
        event.type !== "message.assistant" &&
        event.type !== "feedback.updated" &&
        event.type !== "turn.trace" &&
        event.type !== "temper.trace" &&
        event.type !== "behavior.selected"
      ) {
        throw new Error("Unsupported session event");
      }
      nextState = applyEvent(nextState, event);
      const withoutHash: Omit<StoredEvent, "hash"> = {
        schemaVersion: 1,
        seq: state.eventCount + stored.length,
        event,
        previousHash: stored.at(-1)?.hash ?? state.lastHash,
      };
      stored.push({ ...withoutHash, hash: hashEvent(withoutHash) });
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = eventPath(this.directory, sessionId);
    const current = await readFile(path, "utf8");
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, current + stored.map((entry) => `${JSON.stringify(entry)}\n`).join(""), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temp, path);
    nextState.eventCount = state.eventCount + stored.length;
    nextState.lastHash = stored.at(-1)!.hash;
    return nextState;
  }

  async list(): Promise<string[]> {
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(this.directory).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    return names
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => decodeURIComponent(name.slice(0, -6)));
  }
}

export function defaultSessionDirectory(): string {
  return (
    process.env.STATELY_DATA_DIR ??
    join(process.env.HOME ?? ".", ".local", "share", "stately-adaptive-harness")
  );
}
