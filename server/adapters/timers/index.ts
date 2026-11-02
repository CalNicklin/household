import { DBOS } from "@dbos-inc/dbos-sdk";
import { TimerKind, zTimerKind } from "@household/contracts";
import { z } from "zod";
import { acceptTimer } from "../../coordinator/accept.ts";
import type { Runtime } from "../../runtime.ts";
import type { Adapter } from "../registry.ts";
import { localDate } from "../../time.ts";
import { cronOf, expectedFires, SCHEDULES } from "./schedule.ts";

let runtime: Runtime | null = null;

/** PLT-10: a timer firing is a DBOS scheduled workflow, not a cron process. It only hands a message to the coordinator. */
const timerFired = DBOS.registerWorkflow(
  async (scheduledDate: Date, context: unknown) => {
    const rt = runtime;
    if (rt === null) throw new Error("timers adapter not started");
    const { timer } = z.object({ timer: zTimerKind }).parse(context);
    await DBOS.runStep(() => acceptTimer(rt, timer, scheduledDate), { name: "to-coordinator" });
  },
  { name: "timerFired" },
);

/** CH-5: any expected fire since the first one we ever saw that has no run is written to the run log as missed. */
export async function recordMissed(rt: Runtime, now: Date = rt.ports.clock.now()): Promise<number> {
  const api = rt.system("timers");
  const runs = await api.jobs.timerRuns();
  let missed = 0;
  for (const s of SCHEDULES) {
    const mine = runs.filter((r) => r.timer === s.timer);
    const first = mine.map((r) => new Date(r.scheduledFor)).sort((a, b) => a.getTime() - b.getTime())[0];
    if (first === undefined) continue;
    const seen = new Set(mine.map((r) => new Date(r.scheduledFor).getTime()));
    const graceMs = 5 * 60_000;
    for (const at of expectedFires(s, first, new Date(now.getTime() - graceMs), rt.timeZone)) {
      if (seen.has(at.getTime())) continue;
      await api.jobs.recordTimer({ timer: s.timer, scheduledFor: at.toISOString(), missed: true });
      missed += 1;
    }
  }
  return missed;
}

/**
 * HOU-170: DBOS fires a schedule only while the server is up and never backfills, so a server that
 * was down or restarting at 05:30 skipped the day's morning plan for good (the learning, scores,
 * tomorrow's plan and the morning nudges with it). Today's missed morning plan now runs late, once
 * (the fire's duplicate-check key is its scheduled time); the run log still shows it as missed.
 */
export async function runMissedMorningPlan(rt: Runtime, now: Date = rt.ports.clock.now()): Promise<string | null> {
  const today = localDate(now, rt.timeZone);
  const runs = await rt.system("timers").jobs.timerRuns();
  const missed = runs.find((r) => r.timer === TimerKind.morningPlan && r.missed && r.firedAt === null && localDate(new Date(r.scheduledFor), rt.timeZone) === today);
  if (missed === undefined) return null;
  console.warn(JSON.stringify({ event: "timer-run-late", timer: missed.timer, scheduledFor: missed.scheduledFor }));
  return (await acceptTimer(rt, TimerKind.morningPlan, new Date(missed.scheduledFor))).jobId;
}

export const adapter: Adapter = {
  name: "timers",
  start: async (rt) => {
    runtime = rt;
    await DBOS.applySchedules(SCHEDULES.map((s) => ({ scheduleName: `household:${s.timer}`, workflowFn: timerFired, schedule: cronOf(s), context: { timer: s.timer }, cronTimezone: rt.timeZone, automaticBackfill: false })));
    await recordMissed(rt);
    await runMissedMorningPlan(rt);
  },
};
