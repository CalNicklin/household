import { TimerKind } from "@household/contracts";
import { addLocalDays, atLocal, localDate } from "../../time.ts";

/** CH-5: the house's timers, in local time. `hour: null` means every hour. `weekday` 0 = Sunday. `minute` may list several. */
export const SCHEDULES: readonly { timer: TimerKind; minute: number | readonly number[]; hour: number | null; weekday: number | null }[] = [
  { timer: TimerKind.morningPlan, minute: 30, hour: 5, weekday: null },
  { timer: TimerKind.hourlyRefresh, minute: 0, hour: null, weekday: null },
  { timer: TimerKind.reminders, minute: [15, 30, 45], hour: null, weekday: null },
  { timer: TimerKind.deliveries, minute: 30, hour: 7, weekday: null },
  { timer: TimerKind.basketSummary, minute: 0, hour: 18, weekday: null },
  { timer: TimerKind.bins, minute: 0, hour: 19, weekday: null },
  { timer: TimerKind.weekly, minute: 0, hour: 18, weekday: 0 },
  { timer: TimerKind.retention, minute: 15, hour: 3, weekday: null },
];

const minutesOf = (s: (typeof SCHEDULES)[number]): readonly number[] => (typeof s.minute === "number" ? [s.minute] : s.minute);

export function cronOf(s: (typeof SCHEDULES)[number]): string {
  return `${minutesOf(s).join(",")} ${s.hour ?? "*"} * * ${s.weekday ?? "*"}`;
}

/** Every instant a schedule should have fired in [from, to). */
export function expectedFires(s: (typeof SCHEDULES)[number], from: Date, to: Date, timeZone: string): Date[] {
  const out: Date[] = [];
  for (let date = localDate(from, timeZone); date <= localDate(to, timeZone); date = addLocalDays(date, 1)) {
    const day = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (s.weekday !== null && s.weekday !== day) continue;
    const hours = s.hour === null ? Array.from({ length: 24 }, (_, h) => h) : [s.hour];
    for (const h of hours)
      for (const m of minutesOf(s)) {
        const at = atLocal(date, h, m, timeZone);
        if (at >= from && at < to) out.push(at);
      }
  }
  return out;
}
