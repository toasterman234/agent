/**
 * Composition seam for a standalone harness. Expose THIS handler as the only
 * inbound entry point, not the unguarded model/agent callback.
 *
 * This does not provide process isolation or prevent a separately exposed
 * route from calling the underlying agent; that is an integration test.
 */
import { gateInboundFeedback, type FeedbackGateDeps, type IncomingMessage, type FeedbackGateResult } from "./gate.js";

export type GatedTurnResult<T> =
  | { kind: "response"; result: T; feedback: FeedbackGateResult & { replyAllowed: true } }
  | { kind: "blocked"; feedback: FeedbackGateResult & { replyAllowed: false } };

export function createGatedTurnHost<T>(
  deps: FeedbackGateDeps,
  runNormalTurn: (message: IncomingMessage) => Promise<T>,
): (message: IncomingMessage) => Promise<GatedTurnResult<T>> {
  return async (message) => {
    const feedback = await gateInboundFeedback(message, deps);
    if (!feedback.replyAllowed) return { kind: "blocked", feedback };
    const result = await runNormalTurn(message);
    return { kind: "response", result, feedback };
  };
}
