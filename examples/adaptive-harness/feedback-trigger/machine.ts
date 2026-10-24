/**
 * Fixed environment: only the trusted host may send transition events.
 * Merely detecting punctuation cannot grant a reply; a saved, read-back
 * disposition must precede ALLOW_DISMISS or ALLOW_CASE.
 */
import { createMachine } from "xstate";
import { z } from "zod";

export const feedbackTriggerMachine = createMachine({
  id: "adaptive-feedback-gate",
  version: "1",
  schemas: {
    input: z.object({ messageId: z.string(), signal: z.string() }),
    context: z.object({
      messageId: z.string(),
      signal: z.string(),
      reason: z.string(),
      caseRef: z.string(),
    }),
    events: {
      START: z.object({}),
      DISMISS: z.object({ reason: z.string() }),
      CASE: z.object({ reason: z.string() }),
      ALLOW_DISMISS: z.object({}),
      ALLOW_CASE: z.object({ caseRef: z.string() }),
      BLOCK: z.object({ reason: z.string() }),
    },
  },
  context: ({ input }) => ({
    messageId: input.messageId,
    signal: input.signal,
    reason: "",
    caseRef: "",
  }),
  initial: "detected",
  states: {
    detected: {
      on: {
        START: { target: "judging" },
        BLOCK: ({ event }) => ({ target: "blocked", context: { reason: event.reason } }),
      },
    },
    judging: {
      on: {
        DISMISS: ({ event }) => ({
          target: "recordingDismissal",
          context: { reason: event.reason },
        }),
        CASE: ({ event }) => ({
          target: "recordingCase",
          context: { reason: event.reason },
        }),
        BLOCK: ({ event }) => ({ target: "blocked", context: { reason: event.reason } }),
      },
    },
    recordingDismissal: {
      on: {
        ALLOW_DISMISS: { target: "allowed" },
        BLOCK: ({ event }) => ({ target: "blocked", context: { reason: event.reason } }),
      },
    },
    recordingCase: {
      on: {
        ALLOW_CASE: ({ event }) => ({
          target: "allowed",
          context: { caseRef: event.caseRef },
        }),
        BLOCK: ({ event }) => ({ target: "blocked", context: { reason: event.reason } }),
      },
    },
    allowed: {
      type: "final",
      output: ({ context }) => ({
        allowed: true as const,
        messageId: context.messageId,
        caseRef: context.caseRef,
      }),
    },
    blocked: {
      type: "final",
      output: ({ context }) => ({
        allowed: false as const,
        messageId: context.messageId,
        reason: context.reason,
      }),
    },
  },
});
