import { type Person, PersonRole, Section } from "@household/contracts";
import { describe, expect, test } from "vitest";
import { atLocal } from "../time.ts";
import { isDue, reminderFor, reminderPeople, reminderSection, reminderWhen } from "./remind.ts";

const TZ = "Europe/London";
const MON = "2026-11-02";
const TUE = "2026-11-03";
const at = (h: number, m = 0, date = MON) => atLocal(date, h, m, TZ);

const people: Person[] = [
  { id: "priya", name: "Priya", role: PersonRole.adult, nurseryDays: [] },
  { id: "tom", name: "Tom", role: PersonRole.adult, nurseryDays: [] },
  { id: "ivy", name: "Ivy", role: PersonRole.child, nurseryDays: [] },
];

describe("CAP-10: when a reminder is for", () => {
  test("[CAP-10] nothing, 'later' or 'today' is later today with no time", () => {
    for (const phrase of [null, "", "later", "later today", "today"]) expect(reminderWhen(phrase, at(14), TZ), String(phrase)).toEqual({ date: MON, time: null });
  });

  test("[CAP-10] 'tonight' is 8pm today; said after 8pm it is later today with no time", () => {
    expect(reminderWhen("tonight", at(14), TZ)).toEqual({ date: MON, time: "20:00" });
    expect(reminderWhen("tonight", at(21, 10), TZ)).toEqual({ date: MON, time: null });
    expect(reminderWhen("this evening", at(9), TZ)).toEqual({ date: MON, time: "19:00" });
  });

  test("[CAP-10] 'at 8' is the next 8 o'clock still to come today; 'at 3' is the afternoon; am and pm are as said", () => {
    expect(reminderWhen("at 8", at(14), TZ)).toEqual({ date: MON, time: "20:00" });
    expect(reminderWhen("at 8", at(6), TZ)).toEqual({ date: MON, time: "08:00" });
    expect(reminderWhen("at 3", at(9), TZ)).toEqual({ date: MON, time: "15:00" });
    expect(reminderWhen("at 8:30pm", at(9), TZ)).toEqual({ date: MON, time: "20:30" });
    expect(reminderWhen("at 7am", at(5), TZ)).toEqual({ date: MON, time: "07:00" });
    expect(reminderWhen("tonight at 8", at(6), TZ)).toEqual({ date: MON, time: "20:00" });
    expect(reminderWhen("at 17:45", at(9), TZ)).toEqual({ date: MON, time: "17:45" });
  });

  test("[CAP-10] tomorrow, a weekday or a date is that day, read as dayIn reads it (PRO-2)", () => {
    expect(reminderWhen("tomorrow", at(14), TZ)).toEqual({ date: TUE, time: null });
    expect(reminderWhen("tomorrow morning", at(14), TZ)).toEqual({ date: TUE, time: "09:00" });
    expect(reminderWhen("tomorrow at 8", at(14), TZ)).toEqual({ date: TUE, time: "08:00" });
    expect(reminderWhen("on Friday", at(14), TZ)).toEqual({ date: "2026-11-06", time: null });
    expect(reminderWhen("Wednesday 3 November", at(14), TZ)).toBeNull();
  });

  test("[CAP-10] 'in an hour' and 'in 20 minutes' count from now", () => {
    expect(reminderWhen("in an hour", at(14, 5), TZ)).toEqual({ date: MON, time: "15:05" });
    expect(reminderWhen("in 20 minutes", at(23, 50), TZ)).toEqual({ date: TUE, time: "00:10" });
  });
});

describe("CAP-10: who a reminder is for", () => {
  test("[CAP-10] me is the asker, us is every adult, names are the house's adults", () => {
    expect(reminderFor(["me"], "priya", people)).toEqual({ ids: ["priya"], unknown: [] });
    expect(reminderFor(["us"], "priya", people)).toEqual({ ids: ["priya", "tom"], unknown: [] });
    expect(reminderFor(["me", "Tom"], "priya", people)).toEqual({ ids: ["priya", "tom"], unknown: [] });
    expect(reminderFor([], "tom", people)).toEqual({ ids: ["tom"], unknown: [] });
  });

  test("[CAP-10] a name that is not one of the adults is never guessed", () => {
    expect(reminderFor(["Chloe"], "priya", people)).toEqual({ ids: [], unknown: ["Chloe"] });
    expect(reminderFor(["Ivy"], "priya", people).unknown).toEqual(["Ivy"]);
  });

  test("[CAP-10] the screen names who it is for", () => {
    expect(reminderPeople({ for: ["tom", "priya"] }, people)).toBe("Priya & Tom");
  });
});

describe("CAP-10: where a reminder sits", () => {
  const tonight = { date: MON, time: "20:00" };
  test("[CAP-10] Later today until it is due, then Now", () => {
    expect(reminderSection(tonight, MON, at(19, 59), TZ)).toBe(Section.later);
    expect(isDue(tonight, at(19, 59), TZ)).toBe(false);
    expect(reminderSection(tonight, MON, at(20), TZ)).toBe(Section.now);
    expect(isDue(tonight, at(20), TZ)).toBe(true);
  });

  test("[CAP-10] with no time it is Later today all day and never due; tomorrow's is under Tomorrow", () => {
    expect(reminderSection({ date: MON, time: null }, MON, at(23, 59), TZ)).toBe(Section.later);
    expect(isDue({ date: MON, time: null }, at(23, 59), TZ)).toBe(false);
    expect(reminderSection({ date: TUE, time: "09:00" }, MON, at(14), TZ)).toBe(Section.tomorrow);
    expect(reminderSection({ date: "2026-11-06", time: null }, MON, at(14), TZ)).toBeNull();
  });
});
