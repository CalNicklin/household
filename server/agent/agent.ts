import { Agent } from "@mastra/core/agent";
import { type ActionKind, Limits } from "@household/contracts";
import type { PickCandidate } from "../planner/gather.ts";
import { cachedInstructions, costMicros, languageModel, type TokenUsage } from "./model.ts";
import { askedForMore, clampReply } from "./reply.ts";
import { respond } from "./respond.ts";
import type { JobScope } from "./scope.ts";
import { houseTools } from "./tools.ts";

const INSTRUCTIONS = `You run the admin for one family's house. You can only suggest and record; you never move, delete or spend.
Every message is from one of the household's adults. Decide what they mean and call exactly the tools that do it:
- a thought or job with no date → capture (guess tags only from the allowed list). Anything to do, fix, set up, book or buy that is not groceries is a job, even when it names a product ("get the printer working", "buy a new kettle"). One sentence is one capture unless it clearly lists separate jobs.
- "remind me / us / Tom to…" (any name), "don't let me forget to… tonight", "remind us later" → remind, never capture. Pass when as they said it ("tonight", "at 8", "tomorrow") and who as they said it ("me", "us", or names); never work out the time or the people yourself.
- "make the BoyBoy reminder 7:30", "move that reminder to Thursday", "cancel the 9 o'clock reminder", "delete the dentist reminder" → change_reminder / cancel_reminder, never a second remind. Pass which one as they said it (and the About ref for "this" or "that one"). Only when they ask: never change or cancel a reminder on your own. If the tool asks which one, ask them that; if it says which one is already done or cancelled, say so. Never offer to change or cancel a different reminder in its place.
- groceries for the weekly supermarket shop with no list named ("we're out of oat milk", "add it to the shop") → shop; anything added to a named list ("add batteries to the shopping list", "add wrapping paper to the presents list") → add_to_list. Never split a job into shop items.
- "slow day", "sick day", "we're away", "normal day" → set_mode. For a later day ("we're away this weekend", "slow day on Friday") set it now with from (and until for more than one day); never tell them to say it again on the day.
- "if I do one thing, what should it be?", "what should I prioritise today?" → what_now, then answer with that ONE thing and its reason. Never a list. Never ask a question first.
- "Cal can do it", "move this to tomorrow", "done", "not today" → hand_over / move_to_tomorrow / respond, using the About ref for "this"
- "Hannah's doing Thursday" → sitter_booked
- an order confirmation email → record_arrival with the shop and date only
Reply in at most three short sentences unless they ask for more. Plain, warm, no exclamation marks, no health talk, nothing about how they are feeling.
Only say something is done when the tool says it is done, and say what every tool you called did: never that you couldn't change something a tool changed. Only offer what your tools can do: you can set, move, re-time and cancel reminders; you cannot change calendar events. For shopping say what the shop tool says, never that it has been added. Never explain which tool you chose.
Refer to people by name. Never guess anyone's pronouns.
Never mention anything you were not told in this message, the About line or the Memory line.`;

/**
 * A call's tokens, summed over its steps. Mastra reports cache reads as `cachedInputTokens` and
 * cache writes as `cacheCreationInputTokens`, both already included in `inputTokens`.
 */
function tokensOf(usage: { inputTokens?: number | undefined; outputTokens?: number | undefined; cachedInputTokens?: number | undefined; cacheCreationInputTokens?: number | undefined }): TokenUsage {
  return { input: usage.inputTokens ?? 0, cacheRead: usage.cachedInputTokens ?? 0, cacheWrite: usage.cacheCreationInputTokens ?? 0, output: usage.outputTokens ?? 0 };
}

export type AgentResult = { reply: string; inputTokens: number; outputTokens: number; costMicros: number; intent: string };

/**
 * The one agent (PLT-5). Only a job constructs it (PLT-1): it is built from a JobScope, which only
 * the job layer creates. Adding a tool changes this file and tools.ts, never the coordinator.
 */
export class HouseAgent {
  readonly #scope: JobScope;
  readonly #agent: Agent;
  readonly #model: string;

  constructor(scope: JobScope) {
    this.#scope = scope;
    this.#model = scope.rt.env.MODEL_ID;
    this.#agent = new Agent({ id: "house", name: "house", instructions: cachedInstructions(INSTRUCTIONS), model: languageModel(scope.rt.env), tools: houseTools(scope) });
  }

  /** A message in words: the model decides which tools to call and words the reply. */
  async respond(input: { text: string; personName: string; channel: string; about: { ref: string; title: string } | null; memory: string[]; when: string }): Promise<AgentResult> {
    const prompt = [
      `Person: ${input.personName}`,
      `Channel: ${input.channel}`,
      `Time: ${input.when}`,
      input.about === null ? null : `About: ${input.about.title}`,
      input.about === null ? null : `About ref: ${input.about.ref}`,
      input.memory.length === 0 ? null : `Memory: ${input.memory.join(" | ")}`,
      `Message: ${input.text}`,
    ]
      .filter((l) => l !== null)
      .join("\n");
    // limit: agentMaxSteps
    const result = await this.#agent.generate(prompt, { maxSteps: Limits.agentMaxSteps.value });
    const usage = tokensOf(result.usage);
    const intent = this.#scope.toolCalls.map((c) => c.tool).join("+") || "chat";
    return { reply: clampReply(result.text, askedForMore(input.text)), inputTokens: usage.input, outputTokens: usage.output, costMicros: costMicros(this.#model, usage), intent };
  }

  /** A one-tap button press needs no model: it goes straight to the respond tool (CH-8). */
  async tap(ref: string, action: ActionKind, value: string | null): Promise<AgentResult> {
    const say = await respond(this.#scope, ref, action, value);
    this.#scope.toolCalls.push({ tool: "respond", input: { ref, action, value }, output: { say } });
    return { reply: say, inputTokens: 0, outputTokens: 0, costMicros: 0, intent: `tap:${action}` };
  }

  /** The agent's other job: which backlog item fits today's gap. Rules found the candidates. */
  async chooseBacklog(candidates: PickCandidate[]): Promise<{ pick: PickCandidate | null; inputTokens: number; outputTokens: number; costMicros: number }> {
    if (candidates.length === 0) return { pick: null, inputTokens: 0, outputTokens: 0, costMicros: 0 };
    const prompt = ["Choose: one backlog job to offer today. Reply with its id only, or none.", ...candidates.slice(0, 8).map((c) => `- id=${c.itemId} ${c.title} — ${c.why}`)].join("\n");
    const result = await this.#agent.generate(prompt, { toolChoice: "none" });
    const text = result.text.trim();
    const pick = candidates.find((c) => text.includes(c.itemId)) ?? (/\bnone\b/i.test(text) ? null : (candidates[0] ?? null));
    const usage = tokensOf(result.usage);
    return { pick, inputTokens: usage.input, outputTokens: usage.output, costMicros: costMicros(this.#model, usage) };
  }
}
