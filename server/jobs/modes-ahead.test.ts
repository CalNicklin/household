import { type Block, BlockType, Channel, ModeKind, TimerKind } from "@household/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { jobScope } from "../agent/scope.ts";
import { houseTools } from "../agent/tools.ts";
import { acceptTimer } from "../coordinator/accept.ts";
import { testHousehold, type TestHousehold } from "../testing/household.ts";
import { atLocal } from "../time.ts";
import { screenView } from "../views/screen.ts";
import { weekView } from "../views/week.ts";
import { waitForJob } from "./launch.ts";

let h: TestHousehold;
const MON = "2026-11-02";
const FRI = "2026-11-06";
const SAT = "2026-11-07";
const SUN = "2026-11-08";
const TZ = "Europe/London";
const replyTo = async (a: { messageId: string }) => (await h.rt.system("t").jobs.replyFor({ id: a.messageId }))?.text ?? "";
const modeOf = (blocks: readonly Block[]): string | null => {
  const b = blocks.find((x) => x.type === BlockType.mode);
  return b?.type === BlockType.mode ? b.mode : null;
};
const weekModes = async () => Object.fromEntries((await weekView(h.rt, "priya")).days.map((d) => [d.date, modeOf(d.blocks)]));
const timer = async (kind: TimerKind, date: string, hour: number, minute = 0) => {
  h.ports.clock.set(atLocal(date, hour, minute, TZ), true);
  await waitForJob((await acceptTimer(h.rt, kind, atLocal(date, hour, minute, TZ))).jobId);
};

beforeAll(async () => {
  h = await testHousehold();
  await timer(TimerKind.morningPlan, MON, 5, 30);
  h.ports.clock.set(atLocal(MON, 7, 12, TZ), true);
});
afterAll(async () => h.close());

describe("HOU-156: a mode set ahead for a later day", () => {
  test("[MOM-3][MOM-4] 'we're away this weekend' said on Monday leaves today normal and makes Saturday and Sunday away on the Week screen", async () => {
    const reply = await replyTo(await h.sayAndWait("we're away this weekend", { person: "tom", channel: Channel.telegram }));
    expect(reply).toContain("Saturday 7 November to Sunday 8 November");
    expect(await h.rt.system("t").household.activeMode()).toBeNull();
    expect((await screenView(h.rt, "priya", MON)).blocks.some((b) => b.type === BlockType.mode)).toBe(false);
    const week = await weekModes();
    expect(week).toMatchObject({ [MON]: null, [FRI]: null, [SAT]: ModeKind.away, [SUN]: ModeKind.away });
    const sat = (await weekView(h.rt, "priya")).days.find((d) => d.date === SAT);
    const block = sat?.blocks.find((b) => b.type === BlockType.mode);
    expect(block).toMatchObject({ heading: "Away", reason: "Away until the end of Sunday; the app's own suggestions are hidden" });
  });

  test("[MOM-4] a slow day today, and back to normal today, leave the weekend away", async () => {
    await h.sayAndWait("slow day");
    expect((await h.rt.system("t").household.activeMode())?.mode).toBe(ModeKind.slow);
    expect(await weekModes()).toMatchObject({ [MON]: ModeKind.slow, [SAT]: ModeKind.away, [SUN]: ModeKind.away });
    await h.sayAndWait("back to normal");
    expect(await h.rt.system("t").household.activeMode()).toBeNull();
    expect(await weekModes()).toMatchObject({ [MON]: null, [SAT]: ModeKind.away, [SUN]: ModeKind.away });
  });

  test("[MOM-1] 'slow day on Friday' marks Friday only; 'not away on Saturday after all' clears Saturday and keeps Sunday", async () => {
    expect(await replyTo(await h.sayAndWait("slow day on Friday"))).toContain("Friday 6 November");
    await h.sayAndWait("we're not away on Saturday after all");
    expect(await weekModes()).toMatchObject({ "2026-11-05": null, [FRI]: ModeKind.slow, [SAT]: null, [SUN]: ModeKind.away });
  });

  test("[MOM-1][MOM-5] on the day, the morning plan makes it smaller: the mode block, and fixed things still showing", async () => {
    await timer(TimerKind.morningPlan, SUN, 5, 30);
    expect((await h.rt.system("t").household.activeMode())?.mode).toBe(ModeKind.away);
    const blocks = (await screenView(h.rt, "priya", SUN)).blocks;
    expect(blocks.map((b) => b.type)).toEqual([BlockType.context, BlockType.mode, BlockType.composer]);
    expect(blocks[0]?.type === BlockType.context && blocks[0].line).toBe("Away · Tom said so on Monday");
    await timer(TimerKind.morningPlan, "2026-11-09", 5, 30);
    expect(await h.rt.system("t").household.activeMode()).toBeNull();
    expect((await screenView(h.rt, "priya", "2026-11-09")).blocks.some((b) => b.type === BlockType.mode)).toBe(false);
  });

  test("[MOM-4] 'we're away from Saturday until Monday' said on a Monday runs to the Monday after, not today", async () => {
    h.ports.clock.set(atLocal(MON, 9, 0, TZ), true);
    expect(await replyTo(await h.sayAndWait("we're away from Saturday until Monday"))).toContain("Saturday 7 November to Monday 9 November");
    const [away] = await h.rt.system("t").household.modesBetween({ from: atLocal("2026-11-09", 12, 0, TZ).toISOString(), to: atLocal("2026-11-09", 13, 0, TZ).toISOString() });
    expect(away).toMatchObject({ mode: ModeKind.away, startsAt: atLocal(SAT, 0, 0, TZ).toISOString(), endsAt: atLocal("2026-11-10", 0, 0, TZ).toISOString() });
    await h.sayAndWait("we're not away from Saturday until Monday after all");
  });

  test("[PRO-2] a day it can't read sets nothing and asks which day", async () => {
    h.ports.clock.set(atLocal("2026-11-09", 8, 0, TZ), true);
    const before = await h.rt.system("t").household.modesBetween({ from: atLocal("2026-11-09", 0, 0, TZ).toISOString(), to: atLocal("2026-11-30", 0, 0, TZ).toISOString() });
    const execute = houseTools(jobScope(h.rt, "t-job", "t-msg", "priya", Channel.app)).set_mode.execute;
    if (execute === undefined) throw new Error("set_mode has no execute");
    const out = await execute({ mode: ModeKind.away, from: "sometime soon" }, {});
    expect(JSON.stringify(out)).toContain("Which day");
    expect(await h.rt.system("t").household.modesBetween({ from: atLocal("2026-11-09", 0, 0, TZ).toISOString(), to: atLocal("2026-11-30", 0, 0, TZ).toISOString() })).toEqual(before);
  });
});
