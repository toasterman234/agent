import { describe, expect, test } from "vitest";
import { composeBehavior, type BehaviorSelection } from "../behavior-composer.js";

const previous: BehaviorSelection = {
  messageId: "m1",
  version: "1",
  intent: "discuss",
  behaviorId: "conversation",
  mode: "implementation",
  phase: "working",
  goal: "Finish the existing Stately agent integration",
  memoryRefs: [],
  reason: "initial",
};
const messages = [
  {
    messageId: "m1",
    role: "user" as const,
    text: "Finish the existing Stately agent integration",
    createdAt: "",
  },
  { messageId: "assistant-m1", role: "assistant" as const, text: "Working", createdAt: "" },
];

describe("Tardigrade atoms: context-derived behavior projection", () => {
  test("continue preserves previous goal and proposes a typed behavior", () => {
    const { selection, instruction } = composeBehavior(
      { messages, behavior: previous },
      "m2",
      "continue with the same task",
    );
    expect(selection).toMatchObject({
      messageId: "m2",
      intent: "continue",
      behaviorId: "continue-work",
      goal: previous.goal,
      mode: "implementation",
      phase: "working",
    });
    expect(selection.memoryRefs).toEqual(["m1", "assistant-m1"]);
    expect(instruction).toContain("previous active goal");
  });

  test("verification changes phase but preserves goal", () => {
    const { selection } = composeBehavior(
      { messages, behavior: previous },
      "m3",
      "Verify it first",
    );
    expect(selection).toMatchObject({
      intent: "verify",
      behaviorId: "verification",
      mode: "verification",
      phase: "verifying",
      goal: previous.goal,
    });
  });

  test("status does not claim external source access", () => {
    const { selection, instruction } = composeBehavior(
      { messages, behavior: previous },
      "m3",
      "What's the status?",
    );
    expect(selection.behaviorId).toBe("status-check");
    expect(instruction).toContain("unverified live status");
  });

  test("message with no previous goal does not invent an execution continuation", () => {
    const { selection } = composeBehavior({ messages: [], behavior: null }, "m1", "Continue");
    expect(selection.behaviorId).toBe("conversation");
    expect(selection.goal).toBe("Continue");
  });

  test("independent projections are deterministic and never mutate session input", () => {
    const source = { messages, behavior: previous };
    const before = JSON.stringify(source);
    const a = composeBehavior(source, "m2", "revise just the verification");
    const b = composeBehavior(source, "m2", "revise just the verification");
    expect(a).toEqual(b);
    expect(a.selection.behaviorId).toBe("revise-work");
    expect(JSON.stringify(source)).toBe(before);
  });
});
