import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BlockType, ModeKind, zMode } from "@household/contracts";
import { z } from "zod";
import { practicePorts } from "../practice/fakes.ts";
import { loadEnv } from "../server/env.ts";
import { modeOn } from "../server/rules/day.ts";
import { type RecordedDay, zRecordedDay } from "../server/learning/replay.ts";
import { createRuntime } from "../server/runtime.ts";

/** LRN-9: export one day (plan, inputs, taps) from the house's databases into practice/days format. */
const date = process.argv[2];
const dir = process.argv[3] ?? "practice/days";
if (date === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("usage: node scripts/record-day.ts YYYY-MM-DD [dir]");

const zFacts = z.object({
  events: z.array(z.object({ title: z.string(), start: z.string(), end: z.string() })).default([]),
  timeZone: z.string().optional(),
  // HOU-156: plans keep every mode in their window in `modes`; plans saved before it kept the mode on now in `mode`.
  modes: z.array(zMode).default([]),
  mode: z.object({ mode: z.string() }).nullable().default(null),
});

const rt = await createRuntime(loadEnv(), practicePorts());
try {
  const api = rt.system("record-day");
  const latest = (await api.plans.versions({ date })).at(-1);
  const facts = zFacts.parse(latest?.inputs["facts"] ?? {});
  const blocks = (latest?.blocks ?? []).map((b) => ({ id: b.id, type: b.type, title: "title" in b ? b.title : b.type === BlockType.arrival ? b.shop : b.type, reason: b.reason }));
  const events = (await api.learning.events()).filter((e) => e.date === date);
  const modeBlock = latest?.blocks.find((b) => b.type === BlockType.mode);
  const savedMode = modeOn({ modes: facts.modes, timeZone: facts.timeZone ?? rt.timeZone }, date);
  const day: RecordedDay = zRecordedDay.parse({
    date,
    inputs: {
      calendar: facts.events.map((e) => ({ title: e.title, start: e.start, end: e.end })),
      weather: events[0]?.weather ?? "unknown",
      // HOU-156: the day's mode is the one its plan showed (its mode block), else the day's mode from
      // the saved `modes`, else the mode on now that plans saved before HOU-156 kept.
      mode: modeBlock?.type === BlockType.mode ? modeBlock.mode : (savedMode?.mode ?? facts.mode?.mode ?? ModeKind.normal),
    },
    blocks,
    responses: events.map((e) => ({ ref: e.ref, subject: e.subject, action: e.kind, person: e.person, at: e.at, dayPart: e.dayPart, weekday: e.weekday })),
  });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${date}.json`), `${JSON.stringify(day, null, 2)}\n`);
  process.stdout.write(`recorded ${date}: ${day.blocks.length} blocks, ${day.responses.length} responses\n`);
} finally {
  await rt.close();
}
