import { describe, expect, test } from "vitest";
import { dayIn, daysIn } from "./when.ts";

const MON = "2026-11-02";
const TUE = "2026-11-03";

describe("PRO-2: the day a reply means", () => {
  test("[PRO-2] a weekday, full or short, is the next one, today included", () => {
    for (const phrase of ["Tuesday", "tuesday", "Tue", "tues", "on Tuesday", "Jess's doing Tuesday"]) expect(dayIn(phrase, MON), phrase).toBe(TUE);
    expect(dayIn("Monday", MON)).toBe(MON);
    expect(dayIn("Sunday", MON)).toBe("2026-11-08");
  });

  test("[PRO-2] a date, with or without its weekday, is that date (the real model sent 'Tuesday 3 November')", () => {
    for (const phrase of ["Tuesday 3 November", "3 November", "3rd November", "3rd of November", "Nov 3", "November 3rd", "tue 3 nov", "2026-11-03"]) expect(dayIn(phrase, MON), phrase).toBe(TUE);
    expect(dayIn("2 January", "2026-12-30")).toBe("2027-01-02");
    expect(dayIn("Sept 1", MON)).toBe("2027-09-01");
  });

  test("[PRO-2] today, tonight and tomorrow", () => {
    expect(dayIn("tonight", MON)).toBe(MON);
    expect(dayIn("today", MON)).toBe(MON);
    expect(dayIn("this evening", MON)).toBe(MON);
    expect(dayIn("tomorrow", MON)).toBe(TUE);
  });

  test("[PRO-2] no day, an impossible date, or a weekday that disagrees with the date gives nothing, never today", () => {
    for (const phrase of ["sometime", "", "next week", "Wednesday 3 November", "31 November", "2026-02-30"]) expect(dayIn(phrase, MON), phrase).toBeNull();
  });
});

describe("HOU-156: the days a mode set ahead covers", () => {
  test("[MOM-4] 'this weekend' is the coming Saturday and Sunday; on a Sunday it is today", () => {
    for (const phrase of ["this weekend", "the weekend", "weekend"]) expect(daysIn(phrase, MON), phrase).toEqual({ from: "2026-11-07", to: "2026-11-08" });
    expect(daysIn("this weekend", "2026-11-07")).toEqual({ from: "2026-11-07", to: "2026-11-08" });
    expect(daysIn("this weekend", "2026-11-08")).toEqual({ from: "2026-11-08", to: "2026-11-08" });
  });

  test("[PRO-2] any other phrase is the one day dayIn reads, or nothing", () => {
    expect(daysIn("on Friday", MON)).toEqual({ from: "2026-11-06", to: "2026-11-06" });
    expect(daysIn("Tuesday 3 November", MON)).toEqual({ from: TUE, to: TUE });
    for (const phrase of ["next weekend", "sometime", "Wednesday 3 November"]) expect(daysIn(phrase, MON), phrase).toBeNull();
  });
});
