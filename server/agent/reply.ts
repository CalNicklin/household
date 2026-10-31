import { Limits } from "@household/contracts";

/** MOM-9: never more than three sentences unless the person asked for more. */
export function clampReply(text: string, more: boolean): string {
  const trimmed = text.trim();
  if (more) return trimmed;
  const sentences = trimmed.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [trimmed];
  // limit: replyMaxSentences
  return sentences.slice(0, Limits.replyMaxSentences.value).join("").trim();
}

export function askedForMore(text: string): boolean {
  return /\b(tell me more|more detail|explain|in detail|all of it|everything|full list|why exactly)\b/i.test(text);
}
