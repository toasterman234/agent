import { z } from "zod";
import type { FeedbackJudge, FeedbackVerdict, IncomingMessage } from "../feedback-trigger/host.js";
import type { FeedbackSignal } from "../feedback-trigger/detector.js";
import type { ChatProvider } from "./proxy-provider.js";

const verdictSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("dismiss"), reason: z.string().trim().min(1).max(1000) }),
  z.object({
    kind: z.literal("case"),
    reason: z.string().trim().min(1).max(1000),
    category: z.enum(["verification", "agent-behavior", "reliability", "other"]),
  }),
]);

const stripJsonFence = (text: string) =>
  text
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");

export function parseFeedbackVerdict(text: string): FeedbackVerdict {
  const parsed: unknown = JSON.parse(stripJsonFence(text));
  return verdictSchema.parse(parsed);
}

export function createLunaFeedbackJudge(provider: ChatProvider): FeedbackJudge {
  return {
    async evaluate({ message, signal }: { message: IncomingMessage; signal: FeedbackSignal }) {
      const context = (message.context ?? [])
        .slice(-10)
        .map((item) => `${item.role}: ${item.text.slice(0, 1200)}`)
        .join("\n");
      const prompt = [
        "You are a bounded feedback triage judge. The punctuation or eval signal is only a nomination, not proof of failure.",
        "Return ONLY JSON matching one of these shapes:",
        '{"kind":"dismiss","reason":"short reason"}',
        '{"kind":"case","reason":"short reason","category":"verification|agent-behavior|reliability|other"}',
        "Dismiss quoted examples, excitement, or ordinary questions when there is no concrete failure. Choose case only for a specific observable failure or missing verification.",
        `Signal: ${signal.kind} (${signal.matched})`,
        `Current user message: ${message.text.slice(0, 2000)}`,
        `Bounded recent context:\n${context || "(none)"}`,
      ].join("\n\n");
      const result = await provider.generate([{ role: "system", content: prompt }], {
        maxOutputTokens: 220,
      });
      return parseFeedbackVerdict(result.text);
    },
  };
}
