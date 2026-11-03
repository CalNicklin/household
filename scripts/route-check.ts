import { readFileSync, writeFileSync } from "node:fs";
import { ActionKind, ActorKind, Channel } from "@household/contracts";
import { z } from "zod";
import { practicePorts } from "../practice/fakes.ts";
import { resetPractice } from "../practice/seed.ts";
import { HouseAgent } from "../server/agent/agent.ts";
import { setsModeAhead } from "../server/agent/practice-model.ts";
import { jobScope } from "../server/agent/scope.ts";
import { loadEnv } from "../server/env.ts";
import { parsePencil, pencilValue } from "../server/planner/pencil.ts";
import { partStartHour } from "../server/rules/fit.ts";
import { guessTags } from "../server/rules/tags.ts";
import { createRuntime } from "../server/runtime.ts";
import { ensurePostgres } from "../server/testing/postgres.ts";
import { atLocal } from "../server/time.ts";

/**
 * HOU-148: send the routing phrases to the agent with a real model and record which tools it called.
 * Never part of `pnpm check`: CI never calls a model. It runs on a throwaway practice household
 * (prefix `routecheck_<model>`), so nothing reaches the real house.
 *
 *   env -u ANTHROPIC_BASE_URL node scripts/route-check.ts [out.md]
 *
 * with ANTHROPIC_API_KEY already in the environment (exported from a file, never typed on the command
 * line). The script never prints it. It only runs against a Postgres on this machine.
 * MODEL_PROVIDER and MODEL_ID choose the model (default anthropic / claude-opus-5-5); MODEL_PROVIDER=practice
 * runs the same phrases through the practice model.
 */
const zPhrases = z.object({ phrases: z.array(z.object({ text: z.string(), expect: z.array(z.array(z.string())), ahead: z.boolean().optional(), note: z.string().optional() })) });
const { phrases } = zPhrases.parse(JSON.parse(readFileSync(new URL("../practice/phrases/routing.json", import.meta.url), "utf8")));

const pg = await ensurePostgres();
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(pg.url).hostname)) throw new Error("route-check only runs against a Postgres on this machine");
const model = { MODEL_PROVIDER: process.env["MODEL_PROVIDER"] ?? "anthropic", MODEL_ID: process.env["MODEL_ID"] ?? "claude-opus-5-5" };
const env = loadEnv({ DATABASE_URL: pg.url, DB_PREFIX: `routecheck_${model.MODEL_ID.replace(/\W/g, "_")}`, PRACTICE: "true", ...model });
await resetPractice(env);
const ports = practicePorts({ frozen: true });
const rt = await createRuntime(env, ports);

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const rows: string[] = [`Model: ${env.MODEL_PROVIDER} ${env.MODEL_ID}`, "", "| # | Message | Tools called | Expected | OK | Reply |", "|---|---|---|---|---|---|"];
let passed = 0;
const PENCIL_ITEM = "Clean the garage fridge ready for collection by Friday lunchtime";
const pencilRows: string[] = [];
let pencilOk = false;
try {
  for (const [i, p] of phrases.entries()) {
    const scope = jobScope(rt, `route-${i}`, `route-msg-${i}`, "priya", Channel.app);
    let reply = "";
    try {
      reply = (await new HouseAgent(scope).respond({ text: p.text, personName: "Priya", channel: Channel.app, about: null, memory: [], when: rt.ports.clock.now().toISOString() })).reply;
    } catch (e) {
      reply = `error: ${e instanceof Error ? e.message : String(e)}`;
    }
    const tools = scope.toolCalls.map((c) => c.tool);
    const shown = scope.toolCalls.map((c) => `${c.tool}(${JSON.stringify(c.input)})`).join(" + ") || "none";
    // HOU-156: a phrase marked `ahead` must (or must not) set its mode for a later day.
    const ok = p.expect.some((e) => e.join("+") === tools.join("+")) && (p.ahead === undefined || p.ahead === setsModeAhead(scope.toolCalls));
    if (ok) passed++;
    rows.push(`| ${i + 1} | ${cell(p.text)} | ${cell(shown)} | ${p.expect.map((e) => e.join("+")).join(" or ")}${p.ahead === undefined ? "" : p.ahead ? " (ahead)" : " (from now)"} | ${ok ? "yes" : "**no**"} | ${cell(reply)} |`);
    process.stdout.write(`${ok ? "ok  " : "MISS"} ${p.text} -> ${tools.join("+") || "none"}\n`);
  }
  // HOU-178 (PRO-8): "Pencil it in" on Cal's garage fridge, added Monday 2 November, tapped Tuesday at
  // 09:10: the model chooses from the allowed gaps, every one of them before Friday 12:00.
  const tz = rt.timeZone;
  ports.clock.set(atLocal("2026-11-02", 9, 0, tz), true);
  const fridge = await rt.as({ kind: ActorKind.person, person: "cal" }).backlog.create({ text: PENCIL_ITEM, tags: guessTags(PENCIL_ITEM), createdVia: Channel.app, sourceMessage: "route-pencil-item" });
  ports.clock.set(atLocal("2026-11-03", 9, 10, tz), true);
  const scope = jobScope(rt, "route-pencil", "route-pencil-msg", "cal", Channel.app);
  const reply = (await new HouseAgent(scope).tap(`backlog:${fridge.id}`, ActionKind.accept, "2026-11-08 morning")).reply;
  const slot = parsePencil((await rt.system("route-check").plans.responsesForRef({ ref: `backlog:${fridge.id}` }))[0]?.value ?? null);
  const pencil = scope.toolCalls.find((c) => c.tool === "pencil")?.output;
  const inTime = slot !== null && atLocal(slot.date, partStartHour(slot.dayPart), 0, tz) < atLocal("2026-11-06", 12, 0, tz);
  const fromModel = typeof pencil === "object" && pencil !== null && "fromModel" in pencil && pencil.fromModel === true;
  pencilOk = inTime && fromModel;
  pencilRows.push("", "| Pencil it in | Slot | Before Friday 12:00 | Model's own choice | Reply |", "|---|---|---|---|---|", `| ${cell(PENCIL_ITEM)} | ${slot === null ? "none" : pencilValue(slot)} | ${inTime ? "yes" : "**no**"} | ${fromModel ? "yes" : "**no**"} | ${cell(reply)} |`);
  process.stdout.write(`${pencilOk ? "ok  " : "MISS"} pencil it in -> ${slot === null ? "none" : pencilValue(slot)}\n`);
} finally {
  await rt.close();
  await pg.stop();
}
rows.push("", `${passed}/${phrases.length} routed as expected.`, ...pencilRows, "", `Pencil it in: ${pencilOk ? "a gap the model chose, before the deadline" : "**not as expected**"}.`);
const out = process.argv[2];
if (out !== undefined) writeFileSync(out, `${rows.join("\n")}\n`);
process.stdout.write(`${passed}/${phrases.length} routed as expected\n`);
