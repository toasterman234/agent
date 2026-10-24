import { createActor, setup, type SnapshotFrom } from "xstate";
import { z } from "zod";

const pendingFeedbackSchema = z.object({
  messageId: z.string(),
  reason: z.string(),
  signal: z.string().optional(),
  category: z.string().optional(),
});

const contextSchema = z.object({
  sessionId: z.string(),
  machineVersion: z.string(),
  messages: z.array(
    z.object({ messageId: z.string(), text: z.string(), role: z.enum(["user", "assistant"]) }),
  ),
  lastMessageId: z.string().nullable(),
  pendingFeedback: pendingFeedbackSchema.nullable(),
  blockedReason: z.string().nullable(),
  selectedBehavior: z.string().nullable(),
  // Deep-state (machine v2) minimal extensions. The transcript itself stays
  // owned by SessionStore; these are correlation/projection fields only.
  activeGoal: z.string().nullable(),
  activePhase: z.string().nullable(),
  activeBehaviorId: z.string().nullable(),
  pendingMessageId: z.string().nullable(),
  pendingCallKey: z.string().nullable(),
  interruptedReason: z.string().nullable(),
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
  | {
      type: "SELECT_BEHAVIOR";
      messageId: string;
      behaviorId: string;
      goal?: string | null;
      phase?: string | null;
    }
  | { type: "REVIEW_PASSED" }
  | { type: "FEEDBACK_PENDING"; feedback: PendingFeedback }
  | { type: "FEEDBACK_DISMISSED" }
  | { type: "FEEDBACK_FILED" }
  | { type: "MODEL_RESPONSE"; messageId: string; text: string }
  | { type: "MODEL_BLOCKED"; reason: string }
  | { type: "CALL_INITIATED"; messageId: string; callKey: string }
  | { type: "CALL_FAILED"; messageId: string; callKey: string; reason: string }
  | { type: "INTERRUPT"; reason: string }
  | { type: "RESUME_TURN"; messageId: string };

/** Machine version for the durable restore/replay lifecycle (DEEP_STATE_PLAN). */
export const MACHINE_VERSION = "2";
export const CONVERSATION_MACHINE_VERSION = MACHINE_VERSION;
export const CONVERSATION_MACHINE_ID = "stately-adaptive-conversation";

export const BEHAVIOR_IDS = [
  "continue-work",
  "revise-work",
  "verification",
  "status-check",
  "conversation",
] as const;

/** External (host-authorized) event types the journal may carry. */
export const HOST_EVENT_TYPES = [
  "RECEIVE_MESSAGE",
  "SELECT_BEHAVIOR",
  "REVIEW_PASSED",
  "FEEDBACK_PENDING",
  "FEEDBACK_DISMISSED",
  "FEEDBACK_FILED",
  "MODEL_RESPONSE",
  "MODEL_BLOCKED",
  "CALL_INITIATED",
  "CALL_FAILED",
  "INTERRUPT",
  "RESUME_TURN",
] as const;
export type HostEventType = (typeof HOST_EVENT_TYPES)[number];

/** Legal host events per state value — used by the redacted /state view. */
export const LEGAL_EVENTS_BY_STATE: Record<string, HostEventType[]> = {
  awaitingMessage: ["RECEIVE_MESSAGE"],
  reviewing: [
    "SELECT_BEHAVIOR",
    "REVIEW_PASSED",
    "FEEDBACK_PENDING",
    "CALL_INITIATED",
    "CALL_FAILED",
  ],
  generating: [
    "MODEL_RESPONSE",
    "MODEL_BLOCKED",
    "FEEDBACK_PENDING",
    "CALL_INITIATED",
    "CALL_FAILED",
    "INTERRUPT",
  ],
  blocked: ["FEEDBACK_DISMISSED", "FEEDBACK_FILED", "FEEDBACK_PENDING"],
  interrupted: ["RECEIVE_MESSAGE", "RESUME_TURN"],
};

const conversationSetup = setup({
  schemas: {
    input: z.object({ sessionId: z.string() }),
    context: contextSchema,
    events: {
      RECEIVE_MESSAGE: z.object({ messageId: z.string(), text: z.string() }),
      REVIEW_PASSED: z.object({}),
      // goal/phase ride along as host metadata (see ConversationEvent);
      // they are intentionally not required schema fields so existing
      // two-field SELECT_BEHAVIOR sends stay valid.
      SELECT_BEHAVIOR: z.object({
        messageId: z.string(),
        behaviorId: z.string(),
      }),
      FEEDBACK_PENDING: z.object({ feedback: pendingFeedbackSchema }),
      FEEDBACK_DISMISSED: z.object({}),
      FEEDBACK_FILED: z.object({}),
      MODEL_RESPONSE: z.object({ messageId: z.string(), text: z.string() }),
      MODEL_BLOCKED: z.object({ reason: z.string() }),
      CALL_INITIATED: z.object({ messageId: z.string(), callKey: z.string() }),
      CALL_FAILED: z.object({ messageId: z.string(), callKey: z.string(), reason: z.string() }),
      INTERRUPT: z.object({ reason: z.string() }),
      RESUME_TURN: z.object({ messageId: z.string() }),
    },
  },
});

type ReceiveEvent = Extract<ConversationEvent, { type: "RECEIVE_MESSAGE" }>;
const receiveMessage = ({
  context,
  event,
}: {
  context: ConversationContext;
  event: ReceiveEvent;
}) => ({
  target: "reviewing",
  context: {
    ...context,
    lastMessageId: event.messageId,
    blockedReason: null,
    pendingFeedback: null,
    selectedBehavior: null,
    activeBehaviorId: null,
    pendingMessageId: event.messageId,
    pendingCallKey: null,
    interruptedReason: null,
    messages: context.messages.some((m) => m.messageId === event.messageId)
      ? context.messages
      : [
          ...context.messages,
          { messageId: event.messageId, role: "user" as const, text: event.text },
        ],
  },
});

export const conversationMachine = conversationSetup.createMachine({
  id: CONVERSATION_MACHINE_ID,
  version: MACHINE_VERSION,
  context: ({ input }) => ({
    sessionId: input.sessionId,
    machineVersion: MACHINE_VERSION,
    messages: [],
    lastMessageId: null,
    pendingFeedback: null,
    blockedReason: null,
    selectedBehavior: null,
    activeGoal: null,
    activePhase: null,
    activeBehaviorId: null,
    pendingMessageId: null,
    pendingCallKey: null,
    interruptedReason: null,
  }),
  initial: "awaitingMessage",
  states: {
    awaitingMessage: {
      on: { RECEIVE_MESSAGE: receiveMessage },
    },
    reviewing: {
      on: {
        SELECT_BEHAVIOR: ({ context, event }) =>
          context.lastMessageId === event.messageId &&
          (BEHAVIOR_IDS as readonly string[]).includes(event.behaviorId)
            ? {
                context: {
                  ...context,
                  selectedBehavior: event.behaviorId,
                  activeBehaviorId: event.behaviorId,
                  activeGoal: (event as { goal?: string | null }).goal ?? context.activeGoal,
                  activePhase: (event as { phase?: string | null }).phase ?? context.activePhase,
                },
              }
            : undefined,
        CALL_INITIATED: ({ context, event }) =>
          context.lastMessageId === event.messageId
            ? {
                context: {
                  ...context,
                  pendingMessageId: event.messageId,
                  pendingCallKey: event.callKey,
                },
              }
            : undefined,
        CALL_FAILED: ({ context, event }) => ({
          target: "interrupted",
          context: {
            ...context,
            pendingCallKey: null,
            interruptedReason: event.reason,
          },
        }),
        REVIEW_PASSED: { target: "generating" },
        FEEDBACK_PENDING: ({ context, event }) => ({
          target: "blocked",
          context: {
            ...context,
            pendingFeedback: event.feedback,
            blockedReason: event.feedback.reason,
            pendingMessageId: event.feedback.messageId,
          },
        }),
        INTERRUPT: ({ context, event }) => ({
          target: "interrupted",
          context: { ...context, interruptedReason: event.reason, pendingCallKey: null },
        }),
      },
    },
    generating: {
      on: {
        CALL_INITIATED: ({ context, event }) =>
          context.lastMessageId === event.messageId
            ? { context: { ...context, pendingCallKey: event.callKey } }
            : undefined,
        CALL_FAILED: ({ context, event }) => ({
          target: "interrupted",
          context: { ...context, pendingCallKey: null, interruptedReason: event.reason },
        }),
        INTERRUPT: ({ context, event }) => ({
          target: "interrupted",
          context: { ...context, interruptedReason: event.reason },
        }),
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
            pendingMessageId: null,
            pendingCallKey: null,
          },
        }),
        MODEL_BLOCKED: ({ context, event }) => ({
          target: "blocked",
          context: { ...context, blockedReason: event.reason },
        }),
        FEEDBACK_PENDING: ({ context, event }) => ({
          target: "blocked",
          context: {
            ...context,
            pendingFeedback: event.feedback,
            blockedReason: event.feedback.reason,
            pendingMessageId: event.feedback.messageId,
          },
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
            pendingMessageId: event.feedback.messageId,
          },
        }),
      },
    },
    interrupted: {
      on: {
        RECEIVE_MESSAGE: receiveMessage,
        RESUME_TURN: ({ context, event }) =>
          context.lastMessageId === event.messageId
            ? {
                target: "reviewing",
                context: { ...context, interruptedReason: null, pendingCallKey: null },
              }
            : undefined,
      },
    },
  },
});

export type ConversationSnapshot = SnapshotFrom<typeof conversationMachine>;

export function createConversationActor(sessionId: string) {
  return createActor(conversationMachine, { input: { sessionId } });
}

/** Stable idempotency key for one external call within a turn. */
export function callKeyFor(sessionId: string, messageId: string, operation = "luna"): string {
  return `${sessionId}:${messageId}:${operation}`;
}
