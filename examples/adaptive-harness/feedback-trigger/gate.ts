/**
 * Host-side pre-turn boundary. Call BEFORE the normal agent/model response.
 * The host alone owns the state-machine actor and sends its events; never
 * expose ALLOW_* as a model tool. No Letta/Muse/Temper dependency.
 */
import { createActor } from "xstate";
import { detectFeedbackSignal, type FeedbackSignal } from "./detector.js";
import { feedbackTriggerMachine } from "./machine.js";
import {
  dispositionKey,
  sourceHash,
  type DispositionJournal,
  type FeedbackDisposition,
} from "./journal.js";

export interface IncomingMessage {
  sessionId: string;
  messageId: string;
  text: string;
  /** Optional surrounding session messages, supplied by the actual host. */
  context?: ReadonlyArray<{ role: "user" | "assistant" | "tool"; text: string }>;
}

export type FeedbackVerdict =
  | { kind: "dismiss"; reason: string }
  | { kind: "case"; reason: string; category: string };

export interface FeedbackJudge {
  evaluate(input: { message: IncomingMessage; signal: FeedbackSignal }): Promise<FeedbackVerdict>;
}

/** The future #76 intake adapter MUST be idempotent by the supplied key. */
export interface FeedbackCaseSink {
  fileOrLink(input: {
    idempotencyKey: string;
    message: IncomingMessage;
    signal: FeedbackSignal;
    verdict: Extract<FeedbackVerdict, { kind: "case" }>;
  }): Promise<{ ref: string }>;
  /** Independent authoritative readback. A write receipt alone is not enough. */
  verify(ref: string): Promise<boolean>;
}

export type FeedbackGateResult =
  | { replyAllowed: true; status: "no-trigger"; signal?: never; disposition?: never }
  | {
      replyAllowed: true;
      status: "dismissed" | "filed";
      signal: FeedbackSignal;
      disposition: FeedbackDisposition;
    }
  | {
      replyAllowed: false;
      status: "blocked";
      signal?: FeedbackSignal;
      reason: string;
      disposition?: FeedbackDisposition;
    };

export interface FeedbackGateDeps {
  judge: FeedbackJudge;
  journal: DispositionJournal;
  caseSink?: FeedbackCaseSink;
}

/** Every nominated trigger gets a persistent disposition, or blocks a normal reply. */
export async function gateInboundFeedback(
  message: IncomingMessage,
  deps: FeedbackGateDeps,
): Promise<FeedbackGateResult> {
  if (!message.sessionId || !message.messageId || typeof message.text !== "string") {
    return { replyAllowed: false, status: "blocked", reason: "Invalid message identity" };
  }
  const signal = detectFeedbackSignal(message.text);
  if (!signal) return { replyAllowed: true, status: "no-trigger" };
  const key = dispositionKey(message.sessionId, message.messageId);
  const hash = sourceHash(message.text);
  let prior: FeedbackDisposition | undefined;
  try {
    prior = await deps.journal.read(key);
  } catch {
    return { replyAllowed: false, status: "blocked", signal, reason: "Journal read failed" };
  }
  if (prior && (prior.sourceHash !== hash || prior.messageId !== message.messageId)) {
    return { replyAllowed: false, status: "blocked", signal, reason: "Message identity conflict" };
  }
  if (prior?.status === "dismissed") {
    return { replyAllowed: true, status: "dismissed", signal, disposition: prior };
  }
  if (prior?.status === "filed") {
    try {
      if (!prior.caseRef || !deps.caseSink || !(await deps.caseSink.verify(prior.caseRef))) {
        return { replyAllowed: false, status: "blocked", signal, reason: "Case readback failed", disposition: prior };
      }
    } catch {
      return { replyAllowed: false, status: "blocked", signal, reason: "Case readback failed", disposition: prior };
    }
    return { replyAllowed: true, status: "filed", signal, disposition: prior };
  }

  const actor = createActor(feedbackTriggerMachine, {
    input: { messageId: message.messageId, signal: signal.kind },
  });
  actor.start();
  actor.send({ type: "START" });

  const disposition = (
    status: FeedbackDisposition["status"],
    reason: string,
    category?: string,
    caseRef?: string,
  ): FeedbackDisposition => ({
    key,
    messageId: message.messageId,
    sessionId: message.sessionId,
    sourceHash: hash,
    signal,
    status,
    reason,
    ...(category ? { category } : {}),
    ...(caseRef ? { caseRef } : {}),
    recordedAt: new Date().toISOString(),
  });

  // This is a recovery path, not a normal reply. If even the pending write
  // fails we report an unverified blocker, never claim that an issue exists.
  const block = async (reason: string): Promise<FeedbackGateResult> => {
    actor.send({ type: "BLOCK", reason });
    try {
      const saved = await deps.journal.save(disposition("pending", reason));
      const readback = await deps.journal.read(key);
      if (readback?.sourceHash === hash && readback.status === saved.status) {
        return { replyAllowed: false, status: "blocked", signal, reason, disposition: readback };
      }
    } catch {
      // No durable receipt; the host must alert/retry, not send a normal reply.
    }
    return { replyAllowed: false, status: "blocked", signal, reason: `${reason}; persistence unverified` };
  };

  let verdict: FeedbackVerdict;
  try {
    verdict = await deps.judge.evaluate({ message, signal });
  } catch {
    return block("Feedback judgment failed");
  }
  if (!verdict || !verdict.reason?.trim()) return block("Invalid feedback judgment");

  if (verdict.kind === "dismiss") {
    actor.send({ type: "DISMISS", reason: verdict.reason });
    try {
      const saved = await deps.journal.save(disposition("dismissed", verdict.reason));
      const readback = await deps.journal.read(key);
      if (
        saved.status !== "dismissed" ||
        readback?.status !== "dismissed" ||
        readback.sourceHash !== hash
      ) return block("Dismissal readback failed");
      actor.send({ type: "ALLOW_DISMISS" });
      if (!actor.getSnapshot().matches("allowed")) return block("Machine did not authorize reply");
      return { replyAllowed: true, status: "dismissed", signal, disposition: readback };
    } catch {
      return block("Dismissal recording failed");
    }
  }

  if (verdict.kind !== "case" || !verdict.category?.trim()) return block("Invalid case judgment");
  actor.send({ type: "CASE", reason: verdict.reason });
  if (!deps.caseSink) return block("Case intake adapter unavailable");

  try {
    // fileOrLink MUST dedupe by idempotencyKey at the actual case system.
    const filing = await deps.caseSink.fileOrLink({
      idempotencyKey: key,
      message,
      signal,
      verdict,
    });
    if (!filing.ref || !(await deps.caseSink.verify(filing.ref))) {
      return block("Case filing not independently verified");
    }
    const saved = await deps.journal.save(
      disposition("filed", verdict.reason, verdict.category, filing.ref),
    );
    const readback = await deps.journal.read(key);
    if (
      saved.status !== "filed" ||
      readback?.status !== "filed" ||
      readback.sourceHash !== hash ||
      readback.caseRef !== filing.ref
    ) return block("Case disposition readback failed");
    actor.send({ type: "ALLOW_CASE", caseRef: filing.ref });
    if (!actor.getSnapshot().matches("allowed")) return block("Machine did not authorize reply");
    return { replyAllowed: true, status: "filed", signal, disposition: readback };
  } catch {
    return block("Case filing or verification failed");
  }
}
