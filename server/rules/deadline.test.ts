import { describe, expect, test } from "vitest";
import { atLocal, startOfLocalDay } from "../time.ts";
import { deadlineOf, tooLate } from "./deadline.ts";

const TZ = "Europe/London";
const MON = "2026-11-02";
/** An item added on Monday 2 November at 9am. */
const added = (text: string) => ({ text, createdAt: atLocal(MON, 9, 0, TZ).toISOString() });
const at = (text: string) => deadlineOf(added(text), TZ)?.at.toISOString() ?? null;

describe("HOU-178: the deadline in a backlog item's own words", () => {
  test("[CAP-2] Cal's fridge, added Monday 2 November, is needed by Friday 6 November at 12:00", () => {
    const deadline = deadlineOf(added("Clean the garage fridge ready for collection by Friday lunchtime"), TZ);
    expect(deadline?.at.toISOString()).toBe(atLocal("2026-11-06", 12, 0, TZ).toISOString());
    expect(deadline?.words).toBe("by Friday lunchtime");
  });

  test("[CAP-2] 'by Friday' is all of Friday; 'before the 12th' and 'ahead of the weekend' are up to their start; 'by 4 Nov' is all of the 4th", () => {
    expect(at("Return the library books by Friday")).toBe(startOfLocalDay("2026-11-07", TZ).toISOString());
    expect(at("Send the form before the 12th")).toBe(startOfLocalDay("2026-11-12", TZ).toISOString());
    expect(at("Mow the lawn ahead of the weekend")).toBe(startOfLocalDay("2026-11-07", TZ).toISOString());
    expect(at("Book the MOT by 4 Nov")).toBe(startOfLocalDay("2026-11-05", TZ).toISOString());
  });

  test("[CAP-2] the day is read from when the item was added, not from today: 'by Friday' said on Monday is that Friday", () => {
    const later = { text: "Return the library books by Friday", createdAt: atLocal("2026-11-07", 9, 0, TZ).toISOString() };
    expect(at(later.text)).toBe(startOfLocalDay("2026-11-07", TZ).toISOString());
    expect(deadlineOf(later, TZ)?.at.toISOString()).toBe(startOfLocalDay("2026-11-14", TZ).toISOString());
    // "the 12th" added after the 12th is next month's.
    expect(deadlineOf({ text: "Pay the nursery before the 12th", createdAt: atLocal("2026-11-20", 9, 0, TZ).toISOString() }, TZ)?.at.toISOString()).toBe(startOfLocalDay("2026-12-12", TZ).toISOString());
  });

  test("[CAP-2] times of day: morning, evening, a clock time, tomorrow", () => {
    expect(at("Get the bins ready by Thursday morning")).toBe(atLocal("2026-11-05", 9, 0, TZ).toISOString());
    expect(at("Wrap the present by Saturday evening")).toBe(atLocal("2026-11-07", 19, 0, TZ).toISOString());
    expect(at("Drop the parcel off by Wednesday at 4")).toBe(atLocal("2026-11-04", 16, 0, TZ).toISOString());
    expect(at("Ring the plumber by tomorrow")).toBe(startOfLocalDay("2026-11-04", TZ).toISOString());
    // A clock time with a colon or a dot, before or after the day (AR-2).
    expect(at("Pay the council tax by 8:30am Friday")).toBe(atLocal("2026-11-06", 8, 30, TZ).toISOString());
    expect(at("Move the car before 10:30 tomorrow")).toBe(atLocal("2026-11-03", 10, 30, TZ).toISOString());
    expect(at("Drop the forms off by 9.30 on Thursday")).toBe(atLocal("2026-11-05", 9, 30, TZ).toISOString());
    expect(at("Collect the parcel by Friday at 4:15pm.")).toBe(atLocal("2026-11-06", 16, 15, TZ).toISOString());
  });

  test("[CAP-2] no deadline: no day after by / before / ahead of, or none at all", () => {
    for (const text of ["Clean the garage fridge", "Pay the window cleaner by card", "Fix the light by the back door", "Sort the loft before Christmas", "Call the bank by 4pm"]) expect(at(text), text).toBeNull();
  });

  test("[CAP-2] a day that can't be settled gives no deadline, never a guess: the 3rd is a Tuesday, 'next Friday' could be either, there is no 31st of November", () => {
    for (const text of ["Post the card by Wednesday 3 November", "Clear the shed by next Friday", "Renew the insurance before the 31st"]) expect(at(text), text).toBeNull();
  });

  test("[CAP-2] a gap that starts at or after the deadline is too late; one before it is not", () => {
    const deadline = deadlineOf(added("Clean the garage fridge ready for collection by Friday lunchtime"), TZ);
    expect(tooLate(deadline, atLocal("2026-11-06", 11, 0, TZ))).toBe(false);
    expect(tooLate(deadline, atLocal("2026-11-06", 12, 0, TZ))).toBe(true);
    expect(tooLate(deadline, atLocal("2026-11-08", 7, 0, TZ))).toBe(true);
    expect(tooLate(null, atLocal("2026-12-25", 7, 0, TZ))).toBe(false);
  });
});
