import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createActor } from "xstate";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectFeedbackSignal } from "./detector.js";
import { gateInboundFeedback, type FeedbackCaseSink, type FeedbackGateDeps } from "./gate.js";
import { dispositionKey, FileDispositionJournal, type DispositionJournal } from "./journal.js";
import { feedbackTriggerMachine } from "./machine.js";
import { createGatedTurnHost } from "./host.js";

describe("feedback signal nomination — #388", () => {
  test.each([
    ["???", "punctuation-burst"],
    ["?!?", "punctuation-burst"],
    ["!!!", "punctuation-burst"],
    ["!!?", "punctuation-burst"],
    ["What happened??????", "punctuation-burst"],
    ["??", "punctuation-only"],
    ["?", "punctuation-only"],
    [" ! ", "punctuation-only"],
    ["Eval case right here - the agent never filed it", "explicit-feedback"],
    ["Eval/feedback - missed the record", "explicit-feedback"],
    ["/eval failure", "explicit-feedback"],
  ])("%s nominates %s", (input, kind) => {
    expect(detectFeedbackSignal(input)?.kind).toBe(kind);
  });

  test.each(["Normal question?", "Great!", "I have feedback about a tool.", "....", ""])(
    "%s doesn't nominate",
    (input) => expect(detectFeedbackSignal(input)).toBeNull(),
  );
  test("quoting punctuation nominates, not automatically files", () => {
    expect(detectFeedbackSignal("For example, `???` is a trigger")?.kind).toBe(
      "punctuation-burst",
    );
  });
});

describe("host-owned XState environment", () => {
  test("cannot jump from detected/judging to allowed without recorded path", () => {
    const actor = createActor(feedbackTriggerMachine, {
      input: { messageId: "m-1", signal: "punctuation-burst" },
    });
    actor.start();
    actor.send({ type: "ALLOW_CASE", caseRef: "fake" });
    expect(actor.getSnapshot().matches("detected")).toBe(true);
    actor.send({ type: "START" });
    actor.send({ type: "ALLOW_DISMISS" });
    expect(actor.getSnapshot().matches("judging")).toBe(true);
    actor.send({ type: "DISMISS", reason: "quoted punctuation" });
    actor.send({ type: "ALLOW_CASE", caseRef: "fake" });
    expect(actor.getSnapshot().matches("recordingDismissal")).toBe(true);
    actor.send({ type: "ALLOW_DISMISS" });
    expect(actor.getSnapshot().matches("allowed")).toBe(true);
    actor.stop();
  });
});

describe("host-gated feedback with file-backed journal", () => {
  let root: string;
  let journal: FileDispositionJournal;
  const message = (text: string, id = "message-1") => ({
    sessionId: "session-1",
    messageId: id,
    text,
    context: [{ role: "assistant" as const, text: "Previous work is running" }],
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "stately-feedback-"));
    journal = new FileDispositionJournal(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("normal messages skip judgment and persistence", async () => {
    const evaluate = vi.fn().mockResolvedValue({ kind: "dismiss", reason: "none" });
    expect(
      await gateInboundFeedback(message("Any updates?"), { judge: { evaluate }, journal }),
    ).toEqual({ replyAllowed: true, status: "no-trigger" });
    expect(evaluate).not.toHaveBeenCalled();
  });

  test("false positive requires reasoned dismissal and independently readable receipt", async () => {
    const msg = message("For example: ???", "quoted");
    const evaluate = vi.fn().mockResolvedValue({
      kind: "dismiss",
      reason: "Quoted punctuation examples; no observed agent failure",
    });
    const deps: FeedbackGateDeps = { judge: { evaluate }, journal };
    const first = await gateInboundFeedback(msg, deps);
    expect(first).toMatchObject({
      replyAllowed: true,
      status: "dismissed",
      disposition: { status: "dismissed", messageId: "quoted" },
    });
    expect((await journal.read(dispositionKey("session-1", "quoted")))?.reason).toContain(
      "Quoted",
    );
    const second = await gateInboundFeedback(msg, deps);
    expect(second).toEqual(first);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  test("actual case must be filed, verified and journaled before reply", async () => {
    const evaluate = vi.fn().mockResolvedValue({
      kind: "case",
      reason: "Repeated status claim without source readback",
      category: "verification",
    });
    const fileOrLink = vi.fn().mockResolvedValue({ ref: "case:386" });
    const verify = vi.fn().mockResolvedValue(true);
    const caseSink: FeedbackCaseSink = { fileOrLink, verify };
    const msg = message("update???????????", "status");
    const deps = { judge: { evaluate }, journal, caseSink };
    const first = await gateInboundFeedback(msg, deps);
    expect(first).toMatchObject({
      replyAllowed: true,
      status: "filed",
      disposition: { status: "filed", caseRef: "case:386", category: "verification" },
    });
    const second = await gateInboundFeedback(msg, deps);
    expect(second.status).toBe("filed");
    expect(fileOrLink).toHaveBeenCalledTimes(1);
    expect(fileOrLink.mock.calls[0]?.[0].idempotencyKey).toBe(
      dispositionKey("session-1", "status"),
    );
    expect(verify).toHaveBeenCalledTimes(2);
  });

  test("without a case sink the gate persists pending and blocks; retry may recover", async () => {
    const msg = message("???", "recover");
    const judge = {
      evaluate: vi.fn().mockResolvedValue({
        kind: "case",
        reason: "Potential repeated problem",
        category: "agent-behavior",
      }),
    };
    const first = await gateInboundFeedback(msg, { judge, journal });
    expect(first).toMatchObject({
      replyAllowed: false,
      status: "blocked",
      disposition: { status: "pending" },
    });
    const sink: FeedbackCaseSink = {
      fileOrLink: async () => ({ ref: "case:fix" }),
      verify: async () => true,
    };
    const next = await gateInboundFeedback(msg, { judge, journal, caseSink: sink });
    expect(next).toMatchObject({ replyAllowed: true, status: "filed" });
  });

  test("write receipt is insufficient when case readback fails", async () => {
    const judge = {
      evaluate: async () => ({
        kind: "case" as const,
        reason: "Status omitted readback",
        category: "verification",
      }),
    };
    const caseSink: FeedbackCaseSink = {
      fileOrLink: async () => ({ ref: "case:unverified" }),
      verify: async () => false,
    };
    const result = await gateInboundFeedback(message("?!?", "unverified"), {
      judge,
      journal,
      caseSink,
    });
    expect(result.replyAllowed).toBe(false);
    expect(result.disposition?.status).toBe("pending");
  });

  test("judge errors block and persist a pending disposition", async () => {
    const msg = message("!!?", "judge-outage");
    const first = await gateInboundFeedback(msg, {
      judge: { evaluate: async () => { throw new Error("down"); } },
      journal,
    });
    expect(first).toMatchObject({ replyAllowed: false, status: "blocked" });
    expect((await journal.read(dispositionKey("session-1", "judge-outage")))?.status).toBe(
      "pending",
    );
    const second = await gateInboundFeedback(msg, {
      judge: { evaluate: async () => ({ kind: "dismiss", reason: "No failure" }) },
      journal,
    });
    expect(second).toMatchObject({ replyAllowed: true, status: "dismissed" });
  });

  test("journal read errors fail closed, not like a new message", async () => {
    const badJournal: DispositionJournal = {
      read: async () => { throw new Error("disk unavailable"); },
      save: async () => { throw new Error("disk unavailable"); },
    };
    const result = await gateInboundFeedback(message("???"), {
      judge: { evaluate: async () => ({ kind: "dismiss", reason: "example" }) },
      journal: badJournal,
    });
    expect(result).toMatchObject({
      replyAllowed: false,
      status: "blocked",
      reason: "Journal read failed",
    });
  });

  test("reuse of a message ID with different text is blocked", async () => {
    const judge = { evaluate: async () => ({ kind: "dismiss" as const, reason: "example" }) };
    const first = await gateInboundFeedback(message("???", "collision"), { judge, journal });
    expect(first.replyAllowed).toBe(true);
    const second = await gateInboundFeedback(message("!!!", "collision"), { judge, journal });
    expect(second).toMatchObject({
      replyAllowed: false,
      status: "blocked",
      reason: "Message identity conflict",
    });
  });

  test("journal contents survive a new journal instance and read as JSON", async () => {
    const msg = message("??", "restart");
    await gateInboundFeedback(msg, {
      judge: { evaluate: async () => ({ kind: "dismiss", reason: "Short check-in" }) },
      journal,
    });
    const other = new FileDispositionJournal(root);
    expect((await other.read(dispositionKey("session-1", "restart")))?.status).toBe(
      "dismissed",
    );
    const files = await import("node:fs/promises").then((fs) => fs.readdir(root));
    const raw = await readFile(join(root, files.find((f) => f.endsWith(".json"))!), "utf8");
    expect(JSON.parse(raw).messageId).toBe("restart");
  });
});


describe("composed host ingress cannot skip a blocked disposition", () => {
  test("case signal blocks normal turn until verified, then resumes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stately-feedback-host-"));
    try {
      const journal = new FileDispositionJournal(dir);
      const judge = {
        evaluate: async () => ({
          kind: "case" as const,
          reason: "Repeated status assertion without reading worker record",
          category: "verification",
        }),
      };
      const normalTurn = vi.fn().mockResolvedValue("normal answer");
      const incoming = { sessionId: "host", messageId: "m1", text: "status?????" };
      const blockedHost = createGatedTurnHost({ judge, journal }, normalTurn);
      expect(await blockedHost(incoming)).toMatchObject({
        kind: "blocked",
        feedback: { replyAllowed: false, status: "blocked" },
      });
      expect(normalTurn).not.toHaveBeenCalled();

      const sink: FeedbackCaseSink = {
        fileOrLink: async () => ({ ref: "case:host" }),
        verify: async () => true,
      };
      const allowedHost = createGatedTurnHost({ judge, journal, caseSink: sink }, normalTurn);
      expect(await allowedHost(incoming)).toMatchObject({
        kind: "response",
        result: "normal answer",
        feedback: { replyAllowed: true, status: "filed" },
      });
      expect(normalTurn).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
