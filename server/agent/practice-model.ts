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
// HOU-148: "get the printer working", "buy a new kettle", "get the bins out" are jobs, not groceries:
// a named thing ("the", "a", "my"…) after the verb is something to do, captured whole and never split
// into shop items — unless it is a grocery quantity ("a loaf of bread", "a pint of milk").
const QUANTITY = "(?:a|an)\\s+(?:loaf|pint|litre|dozen|bag|bottle|box|pack|packet|tin|jar|tub|carton|bunch)\\b";
const SHOP_NEED = new RegExp(
  `^(?:we )?(?:need|buy|get|grab|pick up)\\s+(?:some |more )?(?!to\\b)(?!(?!${QUANTITY})(?:the|a|an|my|our|your|his|her|their|this|that)\\b)(.+?)(?:\\s+from the (?:shop|supermarket))?$`,
  "i",
);
const JOB = /\b(working|fixed|repaired|serviced|sorted|connected|set up|installed|replaced|done)\b/i;
const SHOP_ADD = /\b(?:add|put)\s+(.+?)\s+(?:to|in|on)\s+the\s+(?:next\s+)?(?:shop|shopping|basket|order|ocado|supermarket)\b/i;
const LIST_ADD = /\badd\s+(.+?)\s+to\s+(?:the\s+)?(.+?)\s+list\b/i;

const splitItems = (s: string) =>
  s
    .replace(/[.!?]+$/, "")
    .split(/\s*(?:,|\band\b|&)\s*/i)
    .map((x) => x.trim().replace(/^(some|more|a|an)\s+/i, ""))
    .filter((x) => x.length > 0);

// CAP-10: "remind me / us / Tom to…", "don't let me forget to… tonight". Who, then (optionally) when, then the thing.
const REMIND = /^(?:please\s+)?(?:can you\s+)?(?:remind\s+((?:me|us|[a-z]+)(?:(?:\s*,\s*|\s+and\s+)(?:me|us|[a-z]+))*)|don'?t\s+let\s+(me|us)\s+forget)\b\s*(.*)$/i;
const WHEN = /\b(tonight|this (?:evening|afternoon|morning)|tomorrow(?: (?:morning|afternoon|evening|night))?|later(?: today| on)?|at \d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?|in (?:an?|\d+|half an?) ?(?:hours?|minutes?|mins?)?|(?:on )?(?:mon|tues|wednes|thurs|fri|satur|sun)day)\b/i;

/** "remind us to discuss Wise Owls tonight" → remind({ text, for, when }), or null. */
function remindCall(text: string): Call | null {
  const m = REMIND.exec(text.trim());
  if (m === null) return null;
  const who = (m[1] ?? m[2] ?? "me").split(/\s*,\s*|\s+and\s+/i).filter((w) => w !== "");
  let rest = (m[3] ?? "").replace(/[.!]+$/, "").trim();
  let when: string | null = null;
  // "remind me at 8 to call Mum": the time comes before "to".
  const before = /^(.*?)\s+(?:to|about)\s+(.*)$/i.exec(rest);
  if (before?.[1] !== undefined && before[2] !== undefined && WHEN.test(before[1])) {
    when = before[1];
    rest = before[2];
  } else {
    rest = rest.replace(/^(?:to|about)\s+/i, "");
    const w = WHEN.exec(rest);
    if (w !== null) {
      when = rest.slice(w.index).trim();
      rest = rest.slice(0, w.index).trim();
    }
  }
  if (rest === "") return null;
  return { tool: "remind", input: { text: rest.replace(/^./, (c) => c.toUpperCase()), for: who, when } };
}

/** "slow day", "we're away this weekend", "back to normal" → set_mode, or nothing. */
function modeCall(lower: string): Call[] {
  const modeMatch = /\b(slow|sick|lazy|rough|hard|quiet)\s+day\b/.exec(lower);
  const extend = /\b(extend|keep)\b.*\b(slow|sick)\s+day\b.*\b(tomorrow|weekend)\b|\b(slow|sick)\s+day\b.*\b(till|until|through)\s+(tomorrow|the weekend)\b/.exec(lower);
  // HOU-156: a later day ("this weekend", "on Friday", "from Saturday until Monday") sets the mode ahead for it.
  const DAY = "(this weekend|the weekend|tomorrow|(?:mon|tues|wednes|thurs|fri|satur|sun)day|\\d{1,2}(?:st|nd|rd|th)? (?:of )?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)";
  const untilDay = new RegExp(`\\b(?:until|till|through|to)\\s+${DAY}\\b`).exec(lower)?.[1] ?? null;
  const fromDay = new RegExp(`\\bfrom\\s+${DAY}\\b`).exec(lower)?.[1] ?? (/\b(until|till|through)\b/.test(lower) ? null : (new RegExp(`\\b${DAY}\\b`).exec(lower)?.[1] ?? null));
  const from = extend !== null || fromDay === null ? {} : { from: fromDay, ...(untilDay === null ? {} : { until: untilDay }) };
  if (/\b(normal day|back to normal|cancel (the )?(slow|sick) day|not a slow day|not away)\b/.test(lower)) return [{ tool: "set_mode", input: { mode: "normal", ...from } }];
  if (/\b(we're|we are|i'm|i am)\s+away\b|\baway (today|this weekend|until)\b/.test(lower)) return [{ tool: "set_mode", input: { mode: "away", ...from } }];
  if (modeMatch !== null) return [{ tool: "set_mode", input: { mode: modeMatch[1] === "sick" ? "sick" : "slow", until: extend === null ? null : "tomorrow", ...from } }];
  return [];
}

/** Message text → tool calls. Order matters: the most specific phrasing wins. */
function practiceIntent(prompt: string): Call[] {
  const text = field(prompt, "Message") ?? "";
  const about = field(prompt, "About ref");
  const channel = field(prompt, "Channel");
  const lower = text.toLowerCase();

  if (channel === "email") return [{ tool: "record_arrival", input: { email: text } }];

  const calls: Call[] = modeCall(lower);
  if (/\b(one thing|what should i do|what do i do|what can i do|what now|what's next|whats next|if i do one|what should (?:i|we) prioriti[sz]e|focus on)\b/.test(lower)) calls.push({ tool: "what_now", input: {} });
  if (calls.length > 0) return calls;

  const hand = /^(\w+)\s+can\s+do\s+(?:it|this|that)\b|\b(?:give|hand)\s+(?:it|this|that)(?:\s+over)?\s+to\s+(\w+)/i.exec(text);
  if (hand !== null) return [{ tool: "hand_over", input: { ref: about, to: hand[1] ?? hand[2] ?? "" } }];
  if (/\b(move|push|put)\s+(this|it|that)\s+(to|off till|off until)\s+tomorrow\b|\btomorrow instead\b|\bdo (this|it|that) tomorrow\b/.test(lower))
    return [{ tool: "move_to_tomorrow", input: { ref: about } }];
  if (about !== null && /^(done|did it|finished|sorted|all done)\b/.test(lower)) return [{ tool: "respond", input: { ref: about, action: "done" } }];
  if (about !== null && /^not (today|now)\b/.test(lower)) return [{ tool: "respond", input: { ref: about, action: "not-today" } }];

  const reminder = remindCall(text);
  if (reminder !== null) return [reminder];
  const sitter = /\b([A-Z][a-z]+)(?:'s| is)\s+(?:doing|babysitting|sitting|booked for|coming)\s+(?:on\s+)?(\w+day|tonight|tomorrow)\b/.exec(text);
  if (sitter !== null) return [{ tool: "sitter_booked", input: { sitter: sitter[1], when: sitter[2] } }];

  const list = LIST_ADD.exec(text);
  // CAP-6: naming a list ("the shopping list", "the presents list") adds to that list in the app;
  // "we're out of…" or "add … to the shop/basket/order" still goes to the supermarket (AUT-1).
  if (list !== null && !/\b(shop|basket|order|ocado|supermarket)\b/i.test(list[2] ?? "")) return [{ tool: "add_to_list", input: { list: list[2], item: list[1] } }];
  const shop = SHOP_ADD.exec(text) ?? SHOP_OUT.exec(text) ?? (JOB.test(text) ? null : SHOP_NEED.exec(text));
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

/**
 * HOU-156: whether a message's tool calls set its mode for a later day: there is a set_mode call and
 * each one names a day in `from`. The routing phrases' `ahead` is checked with this, by the practice
 * model's test and by scripts/route-check.ts against a real model.
 */
export function setsModeAhead(calls: readonly { tool: string; input: unknown }[]): boolean {
  const modes = calls.filter((c) => c.tool === "set_mode");
  return modes.length > 0 && modes.every((c) => typeof c.input === "object" && c.input !== null && "from" in c.input && typeof c.input.from === "string" && c.input.from !== "");
}
