/**
 * The practice household's model (QA-9). A deterministic AI SDK language model that turns the
 * household's phrasing into the same tool calls a real model makes, so every journey runs end to
 * end in tests and CI with no network and no cost. It goes through the same Mastra loop.
 */
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { guessTags } from "../rules/tags.ts";

type Call = { tool: string; input: Record<string, unknown> };

const zeroUsage = (input: number, output: number): LanguageModelV4Usage => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
});

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((p: unknown) => (typeof p === "object" && p !== null && "text" in p && typeof p.text === "string" ? p.text : ""))
      .join("");
  return "";
}

const field = (prompt: string, name: string): string | null => {
  // The message is always the last field and may span lines (emails).
  const m = name === "Message" ? /^Message: ([\s\S]*)$/m.exec(prompt) : new RegExp(`^${name}: (.*)$`, "m").exec(prompt);
  return m?.[1]?.trim() ?? null;
};

const cleanCapture = (text: string) =>
  text
    .replace(/^(remind me to|reminder:|todo:|to do:|we should|we need to|i need to|need to|don'?t forget to|must)\s+/i, "")
    .replace(/[.!]+$/, "")
    .replace(/^./, (c) => c.toUpperCase());

const SHOP_OUT = /\b(?:we(?:'re| are|'ve| have)?|i(?:'m| am)?)\s+(?:out of|running low on|low on|run out of|nearly out of)\s+(.+)$/i;
const SHOP_NEED = /^(?:we )?(?:need|buy|get|grab|pick up)\s+(?:some |more )?(?!to\b)(.+?)(?:\s+from the (?:shop|supermarket))?$/i;
const SHOP_ADD = /\badd\s+(.+?)\s+to\s+the\s+(?:shop|shopping|basket|order|ocado|supermarket)\b/i;
const LIST_ADD = /\badd\s+(.+?)\s+to\s+(?:the\s+)?(.+?)\s+list\b/i;

const splitItems = (s: string) =>
  s
    .replace(/[.!?]+$/, "")
    .split(/\s*(?:,|\band\b|&)\s*/i)
    .map((x) => x.trim().replace(/^(some|more|a|an)\s+/i, ""))
    .filter((x) => x.length > 0);

/** Message text → tool calls. Order matters: the most specific phrasing wins. */
function practiceIntent(prompt: string): Call[] {
  const text = field(prompt, "Message") ?? "";
  const about = field(prompt, "About ref");
  const channel = field(prompt, "Channel");
  const lower = text.toLowerCase();

  if (channel === "email") return [{ tool: "record_arrival", input: { email: text } }];

  const calls: Call[] = [];
  const modeMatch = /\b(slow|sick|lazy|rough|hard|quiet)\s+day\b/.exec(lower);
  const extend = /\b(extend|keep)\b.*\b(slow|sick)\s+day\b.*\b(tomorrow|weekend)\b|\b(slow|sick)\s+day\b.*\b(till|until|through)\s+(tomorrow|the weekend)\b/.exec(lower);
  if (/\b(normal day|back to normal|cancel (the )?(slow|sick) day|not a slow day)\b/.test(lower)) calls.push({ tool: "set_mode", input: { mode: "normal" } });
  else if (/\b(we're|we are|i'm|i am)\s+away\b|\baway (today|this weekend|until)\b/.test(lower)) calls.push({ tool: "set_mode", input: { mode: "away" } });
  else if (modeMatch !== null) calls.push({ tool: "set_mode", input: { mode: modeMatch[1] === "sick" ? "sick" : "slow", extend: extend === null ? null : "tomorrow" } });
  if (/\b(one thing|what should i do|what do i do|what now|what's next|whats next|if i do one)\b/.test(lower)) calls.push({ tool: "what_now", input: {} });
  if (calls.length > 0) return calls;

  const hand = /^(\w+)\s+can\s+do\s+(?:it|this|that)\b|\b(?:give|hand)\s+(?:it|this|that)(?:\s+over)?\s+to\s+(\w+)/i.exec(text);
  if (hand !== null) return [{ tool: "hand_over", input: { ref: about, to: hand[1] ?? hand[2] ?? "" } }];
  if (/\b(move|push|put)\s+(this|it|that)\s+(to|off till|off until)\s+tomorrow\b|\btomorrow instead\b|\bdo (this|it|that) tomorrow\b/.test(lower))
    return [{ tool: "move_to_tomorrow", input: { ref: about } }];
  if (about !== null && /^(done|did it|finished|sorted|all done)\b/.test(lower)) return [{ tool: "respond", input: { ref: about, action: "done" } }];
  if (about !== null && /^not (today|now)\b/.test(lower)) return [{ tool: "respond", input: { ref: about, action: "not-today" } }];

  const sitter = /\b([A-Z][a-z]+)(?:'s| is)\s+(?:doing|babysitting|sitting|booked for|coming)\s+(?:on\s+)?(\w+day|tonight|tomorrow)\b/.exec(text);
  if (sitter !== null) return [{ tool: "sitter_booked", input: { sitter: sitter[1], when: sitter[2] } }];

  const list = LIST_ADD.exec(text);
  if (list !== null && !/\b(shop|shopping|basket|order)\b/i.test(list[2] ?? "")) return [{ tool: "add_to_list", input: { list: list[2], item: list[1] } }];
  const shop = SHOP_ADD.exec(text) ?? SHOP_OUT.exec(text) ?? SHOP_NEED.exec(text);
  if (shop?.[1] !== undefined) return [{ tool: "shop", input: { items: splitItems(shop[1]) } }];

  if (/\bwhat'?s (on )?today\b|\bwho'?s home\b|\bwhat'?s happening\b/.test(lower)) return [{ tool: "today", input: {} }];

  const cleaned = cleanCapture(text);
  return [{ tool: "capture", input: { text: cleaned, tags: guessTags(cleaned) } }];
}

/** After tools run: say what they said, in one or two sentences. */
function wording(options: LanguageModelV4CallOptions): string {
  const says: string[] = [];
  for (const message of options.prompt) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type !== "tool-result") continue;
      const out = part.output;
      if (out.type === "json" && typeof out.value === "object" && out.value !== null && "say" in out.value && typeof out.value.say === "string") says.push(out.value.say);
    }
  }
  return says.join(" ").trim();
}

function decide(options: LanguageModelV4CallOptions): { content: LanguageModelV4Content[]; finishReason: LanguageModelV4FinishReason } {
  const last = options.prompt.at(-1);
  if (last?.role === "tool") return { content: [{ type: "text", text: wording(options) }], finishReason: { unified: "stop", raw: undefined } };
  const user = [...options.prompt].reverse().find((m) => m.role === "user");
  const prompt = user === undefined ? "" : textOf(user.content);
  if (/^Choose:/m.test(prompt)) {
    const first = /^- id=(\S+)/m.exec(prompt)?.[1] ?? "none";
    return { content: [{ type: "text", text: first }], finishReason: { unified: "stop", raw: undefined } };
  }
  const calls = practiceIntent(prompt);
  return {
    content: calls.map((c, i) => ({ type: "tool-call" as const, toolCallId: `call-${i}`, toolName: c.tool, input: JSON.stringify(c.input) })),
    finishReason: { unified: "tool-calls", raw: undefined },
  };
}

export function practiceModel(modelId: string): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "practice",
    modelId,
    supportedUrls: {},
    async doGenerate(options) {
      const { content, finishReason } = decide(options);
      return { content, finishReason, usage: zeroUsage(40, 10), warnings: [] };
    },
    async doStream(options) {
      const { content, finishReason } = decide(options);
      const parts: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
      for (const c of content) {
        if (c.type === "text") parts.push({ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: c.text }, { type: "text-end", id: "t" });
        else if (c.type === "tool-call") parts.push(c);
      }
      parts.push({ type: "finish", finishReason, usage: zeroUsage(40, 10) });
      return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            for (const p of parts) controller.enqueue(p);
            controller.close();
          },
        }),
      };
    },
  };
}
