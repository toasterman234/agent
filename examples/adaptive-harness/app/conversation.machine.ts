import { createActor, setup, type SnapshotFrom } from "xstate";
import { z } from "zod";

const contextSchema = z.object({
  sessionId: z.string(),
  machineVersion: z.string(),
  messages: z.array(
    z.object({ messageId: z.string(), text: z.string(), role: z.enum(["user", "assistant"]) }),
  ),
  lastMessageId: z.string().nullable(),
  pendingFeedback: z
    .object({
      messageId: z.string(),
      reason: z.string(),
      signal: z.string().optional(),
      category: z.string().optional(),
    })
    .nullable(),
  blockedReason: z.string().nullable(),
  selectedBehavior: z.string().nullable(),
});

export type ConversationMessage = { messageId: string; text: string; role: "user" | "assistant" };
export type PendingFeedback = {
  messageId: string;
  reason: string;
  signal?: string;
  category?: string;
};
export type ConversationContext = z.infer<typeof contextSchema>;
export type ConversationEvent =
  | { type: "RECEIVE_MESSAGE"; messageId: string; text: string }
  | { type: "SELECT_BEHAVIOR"; messageId: string; behaviorId: string }
  | { type: "REVIEW_PASSED" }
  | { type: "FEEDBACK_PENDING"; feedback: PendingFeedback }
  | { type: "FEEDBACK_DISMISSED" }
  | { type: "FEEDBACK_FILED" }
  | { type: "MODEL_RESPONSE"; messageId: string; text: string }
  | { type: "MODEL_BLOCKED"; reason: string };

export const CONVERSATION_MACHINE_VERSION = "1";

const conversationSetup = setup({
  schemas: {
    input: z.object({ sessionId: z.string() }),
    context: contextSchema,
    events: {
      RECEIVE_MESSAGE: z.object({ messageId: z.string(), text: z.string() }),
      REVIEW_PASSED: z.object({}),
      SELECT_BEHAVIOR: z.object({ messageId: z.string(), behaviorId: z.string() }),
      FEEDBACK_PENDING: z.object({ feedback: contextSchema.shape.pendingFeedback.unwrap() }),
      FEEDBACK_DISMISSED: z.object({}),
      FEEDBACK_FILED: z.object({}),
      MODEL_RESPONSE: z.object({ messageId: z.string(), text: z.string() }),
      MODEL_BLOCKED: z.object({ reason: z.string() }),
    },
  },
});

export const conversationMachine = conversationSetup.createMachine({
  id: "stately-adaptive-conversation",
  version: CONVERSATION_MACHINE_VERSION,
  context: ({ input }) => ({
    sessionId: input.sessionId,
    machineVersion: CONVERSATION_MACHINE_VERSION,
    messages: [],
    lastMessageId: null,
    pendingFeedback: null,
    blockedReason: null,
    selectedBehavior: null,
  }),
  initial: "awaitingMessage",
  states: {
    awaitingMessage: {
      on: {
        RECEIVE_MESSAGE: ({ context, event }) => ({
          target: "reviewing",
          context: {
            ...context,
            lastMessageId: event.messageId,
            blockedReason: null,
            pendingFeedback: null,
            selectedBehavior: null,
            messages: [
              ...context.messages,
              { messageId: event.messageId, role: "user" as const, text: event.text },
            ],
          },
        }),
      },
    },
    reviewing: {
      on: {
        SELECT_BEHAVIOR: ({ context, event }) =>
          context.lastMessageId === event.messageId &&
          ["continue-work", "revise-work", "verification", "status-check", "conversation"].includes(
            event.behaviorId,
          )
            ? { context: { ...context, selectedBehavior: event.behaviorId } }
            : undefined,
        REVIEW_PASSED: { target: "generating" },
        FEEDBACK_PENDING: ({ context, event }) => ({
          target: "blocked",
          context: {
            ...context,
            pendingFeedback: event.feedback,
            blockedReason: event.feedback.reason,
          },
        }),
      },
    },
    generating: {
      on: {
        MODEL_RESPONSE: ({ context, event }) => ({
          target: "awaitingMessage",
          context: {
            ...context,
            messages: [
              ...context.messages,
              { messageId: event.messageId, role: "assistant" as const, text: event.text },
            ],
            pendingFeedback: null,
            blockedReason: null,
          },
        }),
        MODEL_BLOCKED: ({ context, event }) => ({
          target: "blocked",
          context: { ...context, blockedReason: event.reason },
        }),
      },
    },
    blocked: {
      on: {
        FEEDBACK_DISMISSED: ({ context }) => ({
          target: "generating",
          context: { ...context, pendingFeedback: null, blockedReason: null },
        }),
        FEEDBACK_FILED: ({ context }) => ({
          target: "generating",
          context: { ...context, pendingFeedback: null, blockedReason: null },
        }),
        FEEDBACK_PENDING: ({ context, event }) => ({
          target: "blocked",
          context: {
            ...context,
            pendingFeedback: event.feedback,
            blockedReason: event.feedback.reason,
          },
        }),
      },
    },
  },
});

export type ConversationSnapshot = SnapshotFrom<typeof conversationMachine>;

export function createConversationActor(sessionId: string) {
  return createActor(conversationMachine, { input: { sessionId } });
}
