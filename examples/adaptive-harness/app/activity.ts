/** Host-observed turn telemetry; no model-authored "thinking" or chain-of-thought.
 * Active state lives in memory only. Finished traces are persisted by SessionStore.
 */
import type { ProviderUsage } from "./proxy-provider.js";

export type TurnStage =
  | "received"
  | "checking-feedback"
  | "judging-feedback"
  | "calling-luna"
  | "saving-response"
  | "feedback-pending"
  | "completed"
  | "failed";

export type TurnStep = {
  stage: TurnStage;
  at: string;
  elapsedMs: number;
};

export type TurnTrace = {
  messageId: string;
  startedAt: string;
  endedAt: string;
  status: "completed" | "blocked" | "failed";
  elapsedMs: number;
  steps: TurnStep[];
  model: string;
  usage?: ProviderUsage;
};

export type TemperCapabilityState =
  | "requested"
  | "authenticating"
  | "reading"
  | "writing"
  | "succeeded"
  | "denied"
  | "failed";

export type TemperCapabilityTrace = {
  capability: string;
  tenant: string;
  principal?: string;
  state: TemperCapabilityState;
  correlationId: string;
  startedAt: string;
  endedAt?: string;
  durationMs: number;
  steps: Array<{ state: TemperCapabilityState; at: string; elapsedMs: number }>;
  result?: string;
  error?: { code: string; message: string; status?: number };
};

type ActiveTurn = {
  messageId: string;
  startedAt: string;
  startedMs: number;
  lastChangedMs: number;
  steps: TurnStep[];
  model: string;
  usage?: ProviderUsage;
};

type ActiveTemperCapability = {
  capability: string;
  tenant: string;
  correlationId: string;
  startedAt: string;
  startedMs: number;
  state: TemperCapabilityState;
  steps: Array<{ state: TemperCapabilityState; at: string; elapsedMs: number }>;
  principal?: string;
};

export class ActivityTracker {
  private readonly active = new Map<string, ActiveTurn>();
  private readonly activeTemper = new Map<string, ActiveTemperCapability>();

  start(sessionId: string, messageId: string, model: string): void {
    const now = Date.now();
    if (this.active.has(sessionId)) throw new Error("Session already has an active turn");
    this.active.set(sessionId, {
      messageId,
      model,
      startedAt: new Date(now).toISOString(),
      startedMs: now,
      lastChangedMs: now,
      steps: [{ stage: "received", at: new Date(now).toISOString(), elapsedMs: 0 }],
    });
  }

  mark(sessionId: string, stage: TurnStage, usage?: ProviderUsage): void {
    const active = this.active.get(sessionId);
    if (!active) return;
    const now = Date.now();
    active.steps.push({
      stage,
      at: new Date(now).toISOString(),
      elapsedMs: now - active.startedMs,
    });
    active.lastChangedMs = now;
    if (usage) active.usage = usage;
  }

  snapshot(sessionId: string) {
    const turn = this.active.get(sessionId);
    if (!turn) return null;
    const now = Date.now();
    return {
      messageId: turn.messageId,
      startedAt: turn.startedAt,
      stage: turn.steps.at(-1)!.stage,
      elapsedMs: now - turn.startedMs,
      stageAgeMs: now - turn.lastChangedMs,
      steps: turn.steps.map((step) => ({ ...step })),
      model: turn.model,
    };
  }

  startTemper(sessionId: string, capability: string, tenant: string, correlationId: string): void {
    if (this.activeTemper.has(sessionId))
      throw new Error("Session already has an active Temper capability");
    const now = Date.now();
    this.activeTemper.set(sessionId, {
      capability,
      tenant,
      correlationId,
      startedAt: new Date(now).toISOString(),
      startedMs: now,
      state: "requested",
      steps: [{ state: "requested", at: new Date(now).toISOString(), elapsedMs: 0 }],
    });
  }

  markTemper(sessionId: string, state: TemperCapabilityState, principal?: string): void {
    const active = this.activeTemper.get(sessionId);
    if (!active) return;
    const now = Date.now();
    active.state = state;
    if (active.steps.at(-1)?.state !== state)
      active.steps.push({
        state,
        at: new Date(now).toISOString(),
        elapsedMs: now - active.startedMs,
      });
    if (principal) active.principal = principal;
  }

  snapshotTemper(sessionId: string): TemperCapabilityTrace | null {
    const active = this.activeTemper.get(sessionId);
    if (!active) return null;
    return {
      capability: active.capability,
      tenant: active.tenant,
      ...(active.principal ? { principal: active.principal } : {}),
      state: active.state,
      correlationId: active.correlationId,
      startedAt: active.startedAt,
      durationMs: Date.now() - active.startedMs,
      steps: active.steps.map((step) => ({ ...step })),
    };
  }

  finishTemper(
    sessionId: string,
    state: Extract<TemperCapabilityState, "succeeded" | "denied" | "failed">,
    details: { principal?: string; result?: string; error?: TemperCapabilityTrace["error"] } = {},
  ): TemperCapabilityTrace | null {
    const active = this.activeTemper.get(sessionId);
    if (!active) return null;
    const now = Date.now();
    this.activeTemper.delete(sessionId);
    return {
      capability: active.capability,
      tenant: active.tenant,
      ...((details.principal ?? active.principal)
        ? { principal: details.principal ?? active.principal }
        : {}),
      state,
      correlationId: active.correlationId,
      startedAt: active.startedAt,
      endedAt: new Date(now).toISOString(),
      durationMs: now - active.startedMs,
      steps: active.steps.map((step) => ({ ...step })),
      ...(details.result ? { result: details.result } : {}),
      ...(details.error ? { error: details.error } : {}),
    };
  }

  finish(sessionId: string, status: TurnTrace["status"]): TurnTrace | null {
    const turn = this.active.get(sessionId);
    if (!turn) return null;
    const lastStage: TurnStage =
      status === "completed" ? "completed" : status === "blocked" ? "feedback-pending" : "failed";
    if (turn.steps.at(-1)?.stage !== lastStage) this.mark(sessionId, lastStage);
    const now = Date.now();
    this.active.delete(sessionId);
    return {
      messageId: turn.messageId,
      startedAt: turn.startedAt,
      endedAt: new Date(now).toISOString(),
      status,
      elapsedMs: now - turn.startedMs,
      steps: turn.steps.map((step) => ({ ...step })),
      model: turn.model,
      ...(turn.usage ? { usage: turn.usage } : {}),
    };
  }
}
