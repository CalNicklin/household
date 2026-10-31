import type { PersonSettings } from "@household/contracts";
import { localHour } from "../time.ts";

export const Delivery = { send: "send", quiet: "quiet", overBudget: "over-budget" } as const;
export type Delivery = (typeof Delivery)[keyof typeof Delivery];

/** Quiet hours wrap midnight: 21 → 7 means 21:00–06:59. */
export function inQuietHours(settings: Pick<PersonSettings, "quietStartHour" | "quietEndHour">, at: Date, timeZone: string): boolean {
  const h = localHour(at, timeZone);
  const { quietStartHour: s, quietEndHour: e } = settings;
  if (s === e) return false;
  return s < e ? h >= s && h < e : h >= s || h < e;
}

/** PRO-7: anything over the limit, or inside quiet hours, waits for the morning screen. */
export function deliveryFor(settings: PersonSettings, sentToday: number, at: Date, timeZone: string): Delivery {
  if (inQuietHours(settings, at, timeZone)) return Delivery.quiet;
  if (sentToday >= settings.dailyMessageBudget) return Delivery.overBudget;
  return Delivery.send;
}
