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
 * Price per million tokens, in micro-dollars (QA-8, QA-10): Anthropic first-party list prices,
 * October 2026. Unknown models are counted at zero.
 */
const PRICES: Record<string, { input: number; output: number }> = {
  "practice-1": { input: 0, output: 0 },
  "claude-opus-5-5": { input: 4_000_000, output: 20_000_000 },
  "claude-sonnet-5-5": { input: 2_000_000, output: 10_000_000 },
  "claude-haiku-5-5": { input: 100_000, output: 500_000 },
};

export function costMicros(model: string, inputTokens: number, outputTokens: number): number {
  const price = PRICES[model];
  if (price === undefined) return 0;
  return Math.round((inputTokens * price.input + outputTokens * price.output) / 1_000_000);
}
