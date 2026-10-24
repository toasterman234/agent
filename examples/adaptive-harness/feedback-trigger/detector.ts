/** Deterministic *nomination*, not a finding of agent failure. No model calls. */
export type FeedbackSignal =
  | { kind: "explicit-feedback"; matched: string }
  | { kind: "punctuation-burst"; matched: string }
  | { kind: "punctuation-only"; matched: string };

/** Explicit commands are anchored so a casual mention of "feedback" isn't a command. */
const explicit = /^\s*(?:\/eval\b|eval(?:uation)?\s*(?:[/:-]\s*feedback|case)\b|feedback\s*[/:-]\s*eval\b)/iu;
const burst = /[!?]{3,}/u;
const onlyPunctuation = /^\s*[!?]{1,3}\s*$/u;

/**
 * Includes `??`: the historical E36 incident started with a punctuation-only
 * two-character message. Quotations and excitement are intentionally nominated
 * and subsequently dismissed by the context judge, with a durable reason.
 */
export function detectFeedbackSignal(text: string): FeedbackSignal | null {
  const command = text.match(explicit);
  if (command) return { kind: "explicit-feedback", matched: command[0].trim() };
  const group = text.match(burst);
  if (group) return { kind: "punctuation-burst", matched: group[0] };
  if (onlyPunctuation.test(text)) return { kind: "punctuation-only", matched: text.trim() };
  return null;
}
