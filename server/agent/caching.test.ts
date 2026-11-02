import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { testHousehold, type TestHousehold } from "../testing/household.ts";
import { HouseAgent } from "./agent.ts";
import { costMicros } from "./model.ts";
import { jobScope } from "./scope.ts";

const zBody = z.looseObject({
  system: z.array(z.looseObject({ type: z.string(), text: z.string(), cache_control: z.unknown().optional() })).optional(),
  tools: z.array(z.looseObject({ name: z.string(), cache_control: z.unknown().optional() })).optional(),
  messages: z.array(z.unknown()),
});
type Body = z.infer<typeof zBody>;

let h: TestHousehold;
beforeAll(async () => {
  h = await testHousehold({ jobs: false, env: { MODEL_PROVIDER: "anthropic", MODEL_ID: "claude-opus-5-5" } });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await h.close();
});

describe("prompt caching on the real provider (no network: the Anthropic API is stubbed)", () => {
  test("[QA-8][PLT-9] a message's two calls share one cached prefix (tools and instructions), and the cost prices cache reads and writes", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", randomBytes(12).toString("base64url"));
    const bodies: Body[] = [];
    // What the API returns for "what's today like": a tool call, then the reply. The first call
    // writes the 5,000-token prefix to the cache and the second reads it.
    const replies = [
      { content: [{ type: "tool_use", id: "toolu_1", name: "today", input: {} }], stop_reason: "tool_use", usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 5000, cache_read_input_tokens: 0 } },
      { content: [{ type: "text", text: "Dry until 2pm." }], stop_reason: "end_turn", usage: { input_tokens: 120, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000 } },
    ];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      bodies.push(zBody.parse(JSON.parse(init.body)));
      const reply = replies[bodies.length - 1];
      return new Response(JSON.stringify({ id: `msg_${bodies.length}`, type: "message", role: "assistant", model: "claude-opus-5-5", stop_sequence: null, ...reply }), { headers: { "content-type": "application/json" } });
    });

    const result = await new HouseAgent(jobScope(h.rt, "job-cache", "msg-cache", "priya", "app")).respond({ text: "what's today like", personName: "Priya", channel: "app", about: null, memory: [], when: "Mon 07:00" });

    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      // Exactly one breakpoint, on the last (only) system block: tools render before it, so both are cached.
      expect(body.system?.map((b) => b.cache_control ?? null)).toEqual([{ type: "ephemeral" }]);
      expect(body.tools?.filter((t) => t.cache_control !== undefined)).toEqual([]);
    }
    expect(JSON.stringify(bodies[1]?.tools)).toBe(JSON.stringify(bodies[0]?.tools));
    expect(JSON.stringify(bodies[1]?.system)).toBe(JSON.stringify(bodies[0]?.system));
    // 220 uncached at $4/M, 5,000 written at $5/M, 5,000 read at $0.20/M, 30 out at $20/M.
    expect(result).toMatchObject({ reply: "Dry until 2pm.", inputTokens: 10220, outputTokens: 30, costMicros: 880 + 25000 + 1000 + 600 });
  });

  test("[QA-8] cache reads cost 5% of input on Opus 5.5, and a model with no price costs nothing", () => {
    expect(costMicros("claude-opus-5-5", { input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, output: 0 })).toBe(200_000);
    expect(costMicros("claude-opus-5-5", { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 })).toBe(4_000_000);
    expect(costMicros("claude-opus-5-5", { input: 1_000_000, cacheRead: 0, cacheWrite: 1_000_000, output: 0 })).toBe(5_000_000);
    expect(costMicros("unknown-model", { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 1_000_000 })).toBe(0);
  });
});
