import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { ModelProvider } from "@household/contracts";
import type { Env } from "../env.ts";
import { practiceModel } from "./practice-model.ts";

/**
 * PLT-9 / CODE-12: the provider is a setting. Every model is an AI SDK model; this is the only
 * file that names a provider, and swapping one changes no application code.
 */
export function languageModel(env: Pick<Env, "MODEL_PROVIDER" | "MODEL_ID">): LanguageModelV4 {
  switch (env.MODEL_PROVIDER) {
    case ModelProvider.practice:
      return practiceModel(env.MODEL_ID);
    case ModelProvider.anthropic:
      return createAnthropic()(env.MODEL_ID);
    case ModelProvider.openai:
      return createOpenAI()(env.MODEL_ID);
  }
}

/**
 * The agent's instructions, marked as the prompt-cache breakpoint. Tool definitions render before
 * the instructions, so one marker here caches both: they are byte-identical on every call, and a
 * message usually makes two calls (the tool, then the reply) seconds apart. The 5-minute TTL fits
 * that; the 1-hour one costs a 2x write that our gaps between messages rarely repay. Providers
 * other than Anthropic ignore the option (PLT-9).
 */
export function cachedInstructions(text: string): { role: "system"; content: string; providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } } {
  return { role: "system", content: text, providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } };
}

/**
 * Price per million tokens, in micro-dollars (QA-8, QA-10): Anthropic first-party list prices,
 * October 2026. A 5-minute cache write is 1.25x input; a cache read is $0.20 on Opus 5.5 and
 * Sonnet 5.5 and 0.1x input on Haiku 5.5. Unknown models are counted at zero.
 */
const PRICES: Record<string, { input: number; cacheWrite: number; cacheRead: number; output: number }> = {
  "practice-1": { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
  "claude-opus-5-5": { input: 4_000_000, cacheWrite: 5_000_000, cacheRead: 200_000, output: 20_000_000 },
  "claude-sonnet-5-5": { input: 2_000_000, cacheWrite: 2_500_000, cacheRead: 200_000, output: 10_000_000 },
  "claude-haiku-5-5": { input: 100_000, cacheWrite: 125_000, cacheRead: 10_000, output: 500_000 },
};

/** Tokens for one agent call or a sum of them. `input` is the total, cache reads and writes included. */
export type TokenUsage = { input: number; cacheRead: number; cacheWrite: number; output: number };

export function costMicros(model: string, usage: TokenUsage): number {
  const price = PRICES[model];
  if (price === undefined) return 0;
  const uncached = Math.max(0, usage.input - usage.cacheRead - usage.cacheWrite);
  return Math.round((uncached * price.input + usage.cacheWrite * price.cacheWrite + usage.cacheRead * price.cacheRead + usage.output * price.output) / 1_000_000);
}
