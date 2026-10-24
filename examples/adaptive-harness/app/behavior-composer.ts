/**
 * Tardigrade atom-based, read-only behavior composition.
 *
 * Stately's hash-chained session journal owns history and the persisted
 * selection. We rebuild this pure atom graph for each turn; no independent
 * Tardigrade thread, durable actor, host or second state store is created.
 */
import { atom, createStore } from "tardie/core";
import type { SessionState } from "./session-store.js";

export const BEHAVIOR_VERSION = "1";
export type BehaviorIntent = "continue" | "revise" | "verify" | "status" | "discuss";
export type BehaviorMode = "conversation" | "implementation" | "verification";
export type BehaviorPhase = "ready" | "working" | "verifying";
export type BehaviorId =
  | "continue-work"
  | "revise-work"
  | "verification"
  | "status-check"
  | "conversation";

export type BehaviorSelection = {
  messageId: string;
  version: string;
  intent: BehaviorIntent;
  behaviorId: BehaviorId;
  mode: BehaviorMode;
  phase: BehaviorPhase;
  goal: string | null;
  memoryRefs: string[];
  reason: string;
};

/** No LLM, no tool calls, no mutable state: conservative intent nomination. */
function classify(text: string): BehaviorIntent {
  const t = text.trim();
  if (/^(?:please\s+)?(?:continue|resume|pick up|carry on|keep going)\b/iu.test(t))
    return "continue";
  if (/^(?:please\s+)?(?:change|revise|modify|instead|actually|but change|update the approach)\b/iu.test(t))
    return "revise";
  if (/^(?:please\s+)?(?:verify|check (?:the|it|that)|test (?:the|it|that)|validate|prove)\b/iu.test(t))
    return "verify";
  if (/^(?:status|what(?:'s| is) the status|any updates|where are we|what happened|what's happening)\b/iu.test(t))
    return "status";
  return "discuss";
}

const instructions: Record<BehaviorId, string> = {
  "continue-work": "Continue the previous active goal. Do not create a new project or claim work you have not performed.",
  "revise-work": "Keep the previous active goal; revise only the requested dimension. Preserve earlier evidence and restrictions.",
  verification: "Identify evidence needed to verify claims. Do not mark a task complete from an agent assertion alone.",
  "status-check": "Distinguish known recorded progress from unverified live status; do not infer a negative from a missing ping.",
  conversation: "Answer the current message. Do not assume a new executable project or an active tool capability.",
};

export function composeBehavior(
  state: Pick<SessionState, "messages" | "behavior">,
  messageId: string,
  text: string,
): { selection: BehaviorSelection; instruction: string } {
  // The inputs are snapshots of Stately-owned data, not a Tardigrade store.
  const previous = atom(state.behavior);
  const history = atom(state.messages);
  const currentText = atom(text);
  const intent = atom((get) => classify(get(currentText)));
  const context = atom((get) => {
    const prior = get(previous);
    const route = get(intent);
    const recent = get(history).slice(-8).map((item) => item.messageId);
    const continuing = Boolean(prior?.goal);
    const behaviorId: BehaviorId =
      route === "continue" && continuing ? "continue-work" :
      route === "revise" && continuing ? "revise-work" :
      route === "verify" ? "verification" :
      route === "status" ? "status-check" : "conversation";
    const firstNewGoal = get(currentText).trim().slice(0, 180) || null;
    const goal = continuing && ["continue", "revise", "status", "verify"].includes(route)
      ? prior!.goal
      : route === "discuss" ? firstNewGoal : prior?.goal ?? firstNewGoal;
    const mode: BehaviorMode = behaviorId === "verification" ? "verification"
      : behaviorId === "continue-work" || behaviorId === "revise-work"
        ? (prior?.mode === "verification" ? "verification" : "implementation")
        : prior?.mode ?? "conversation";
    const phase: BehaviorPhase = behaviorId === "verification"
      ? "verifying"
      : behaviorId === "continue-work" || behaviorId === "revise-work" ? "working"
      : prior?.phase ?? "ready";
    return {
      messageId,
      version: BEHAVIOR_VERSION,
      intent: route,
      behaviorId,
      mode,
      phase,
      goal,
      memoryRefs: recent,
      reason: continuing && ["continue", "revise", "status", "verify"].includes(route)
        ? "Current message interpreted with the previously persisted goal."
        : "Selected from the current message and available session context.",
    } satisfies BehaviorSelection;
  });
  const store = createStore();
  try {
    const selection = store.get(context);
    return { selection, instruction: behaviorInstructions(selection) };
  } finally {
    store.dispose();
  }
}

/** Reuse persisted selection on retries; never reclassify one message ID. */
export function behaviorInstructions(selection: BehaviorSelection): string {
  return [
    "# Host-selected behavior (Tardigrade projection; subject to XState gate)",
    `Behavior: ${selection.behaviorId}; intent: ${selection.intent}; mode: ${selection.mode}; phase: ${selection.phase}.`,
    selection.goal ? `Active goal: ${selection.goal}` : "No confirmed active goal.",
    `Relevant local message IDs: ${selection.memoryRefs.join(", ") || "none"}.`,
    instructions[selection.behaviorId],
    "The host has not granted additional tools, long-term memory, or remote execution through this selection.",
  ].join("\n");
}
