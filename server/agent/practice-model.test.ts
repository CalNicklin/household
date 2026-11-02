import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { practiceModel, setsModeAhead } from "./practice-model.ts";

const zPhrases = z.object({ phrases: z.array(z.object({ text: z.string(), expect: z.array(z.array(z.string())), ahead: z.boolean().optional() })) });
const { phrases } = zPhrases.parse(JSON.parse(readFileSync(new URL("../../practice/phrases/routing.json", import.meta.url), "utf8")));

/** The tools the practice model calls for one message, as the agent would prompt it. */
async function toolsFor(text: string): Promise<{ tools: string[]; inputs: unknown[] }> {
  const prompt = `Person: Priya\nChannel: app\nTime: 2026-11-02T07:00:00.000Z\nMessage: ${text}`;
  const result = await practiceModel("practice-1").doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: prompt }] }] });
  const calls = result.content.flatMap((c) => (c.type === "tool-call" ? [c] : []));
  return { tools: calls.map((c) => c.toolName), inputs: calls.map((c) => JSON.parse(c.input) as unknown) };
}

describe("HOU-148: the practice model routes the household's phrases the way a person would expect", () => {
  test.each(phrases)("[CAP-1][AUT-1][MOM-2] $text", async ({ text, expect: acceptable }) => {
    const { tools } = await toolsFor(text);
    expect(acceptable.map((a) => a.join("+"))).toContain(tools.join("+"));
  });

  test.each(phrases.flatMap((p) => (p.ahead === undefined ? [] : [{ text: p.text, ahead: p.ahead }])))("[MOM-4] set ahead or from now (HOU-156): $text", async ({ text, ahead }) => {
    const { tools, inputs } = await toolsFor(text);
    expect(setsModeAhead(tools.map((tool, i) => ({ tool, input: inputs[i] })))).toBe(ahead);
  });

  test("[MOM-4] a span set ahead names its first and last day (HOU-156)", async () => {
    expect((await toolsFor("we're away from Saturday until Monday")).inputs[0]).toMatchObject({ mode: "away", from: "saturday", until: "monday" });
    expect((await toolsFor("keep the slow day going until tomorrow")).inputs[0]).toMatchObject({ mode: "slow", until: "tomorrow" });
    expect((await toolsFor("keep the slow day going until tomorrow")).inputs[0]).not.toHaveProperty("from");
  });

  test("[CAP-1] Cal's printer sentence is one capture of the whole sentence, never split into shop items", async () => {
    const { tools, inputs } = await toolsFor("get the canon printer working and connected to laptop so we can print loads of photos up to A3");
    expect(tools).toEqual(["capture"]);
    expect(inputs[0]).toMatchObject({ text: "Get the canon printer working and connected to laptop so we can print loads of photos up to A3" });
  });

  test.each(["grab a loaf of bread", "get a pint of milk", "buy a dozen eggs"])("[AUT-1] groceries after an article are still shopping: %s", async (text) => {
    expect((await toolsFor(text)).tools).toEqual(["shop"]);
  });

  test.each(["get the car MOT booked", "buy a birthday present for Jess", "get the boiler looked at", "get the bins out"])("[CAP-1] a named thing after the verb is a job: %s", async (text) => {
    expect((await toolsFor(text)).tools).toEqual(["capture"]);
  });

  test("[AUT-1] 'need new potatoes' is shopping", async () => {
    expect(await toolsFor("need new potatoes")).toEqual({ tools: ["shop"], inputs: [{ items: ["new potatoes"] }] });
  });

  test("[CAP-1] 'prioritise the boiler service' is a job to capture, not a question", async () => {
    expect((await toolsFor("prioritise the boiler service")).tools).toEqual(["capture"]);
  });

  test("[AUT-1] groceries in one sentence are still separate shop items", async () => {
    expect(await toolsFor("we're out of oat milk and bread")).toEqual({ tools: ["shop"], inputs: [{ items: ["oat milk", "bread"] }] });
  });
});
