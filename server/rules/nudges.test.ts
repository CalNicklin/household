import { Limits, NotificationStatus, PersonRole, Section, Urgency } from "@household/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { gatherFacts } from "../planner/gather.ts";
import { testHousehold, type TestHousehold } from "../testing/household.ts";
import { addLocalDays, atLocal } from "../time.ts";
import { deliveryFor, inQuietHours } from "./budget.ts";
import { contextLine, type HouseFacts } from "./day.ts";
import { arrivalsFor, babysitterFor, binsFor, choresFor, nurseryFor, recipientsHomeAt, washingFor } from "./nudges.ts";
import { guessTags } from "./tags.ts";

let h: TestHousehold;
let facts: HouseFacts;
const MON = "2026-11-02";
const TZ = "Europe/London";
const at = (date: string, hour: number, minute = 0) => atLocal(date, hour, minute, TZ);

beforeAll(async () => {
  h = await testHousehold({ jobs: false });
  facts = await gatherFacts(h.rt, "2026-10-28", 20);
});
afterAll(async () => h.close());

describe("PRO-8 / QA-7: every reminder is a plain rule with a plain test", () => {
  test("[HOME-2] the top line says the weather window, when it gets dark, and who is home until when", () => {
    const line = contextLine(facts, MON, at(MON, 7));
    expect(line).toMatch(/^Dry until 2pm, 9° · dark by \d\d:\d\d · both home (all day|until \d+)$/);
    const wed = contextLine(facts, "2026-11-04", at("2026-11-04", 7));
    expect(wed).toContain("Priya home");
  });

  test("[PRO-1] both out in the evening, no sitter: a warning from a week before, a reminder naming a sitter at five days", () => {
    // Theatre on Thursday 12 November, both out.
    // limit: sitterWarnDays
    const eightBefore = babysitterFor(facts, addLocalDays("2026-11-12", -(Limits.sitterWarnDays.value + 1)));
    expect(eightBefore.items.filter((i) => i.ref === "sitter:2026-11-12")).toHaveLength(0);
    // limit: sitterWarnDays
    const weekBefore = babysitterFor(facts, addLocalDays("2026-11-12", -Limits.sitterWarnDays.value));
    const warning = weekBefore.items.find((i) => i.ref === "sitter:2026-11-12");
    expect(warning?.kind).toBe("alert");
    expect(weekBefore.nudges.filter((n) => n.key.startsWith("sitter:2026-11-12"))).toHaveLength(0);
    // limit: sitterRemindDays
    const fiveBefore = babysitterFor(facts, addLocalDays("2026-11-12", -Limits.sitterRemindDays.value));
    const reminders = fiveBefore.nudges.filter((n) => n.key === "sitter:2026-11-12:remind");
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.message).toMatch(/Message (Jess|Marta)\?/);
    expect(reminders[0]?.urgency).toBe(Urgency.urgent);
    expect("person" in (reminders[0]?.to ?? {})).toBe(true);
    // The night before, it sits under Tomorrow (Dinner at Sam's on Tuesday).
    const monday = babysitterFor(facts, MON).items.find((i) => i.ref === "sitter:2026-11-03");
    expect(monday?.section).toBe(Section.tomorrow);
    expect(monday?.actions[0]?.label).toBe("Ask Jess");
  });

  test("[PRO-2] a recorded booking makes the warning disappear", () => {
    const booked: HouseFacts = { ...facts, sitterBookings: [{ id: "b", sitter: "Jess", date: "2026-11-03", recordedBy: "tom" }] };
    expect(babysitterFor(booked, MON).items.filter((i) => i.ref === "sitter:2026-11-03")).toHaveLength(0);
  });

  test("[PRO-3] the right bins appear under Later today the evening before collection, with a 7pm message to whoever is home", () => {
    const monday = binsFor(facts, MON);
    expect(monday.items[0]?.section).toBe(Section.later);
    expect(monday.items[0]?.detail).toBe("recycling + food, collected Tuesday");
    expect(monday.nudges[0]?.at).toBe(at(MON, 19).toISOString());
    expect(binsFor(facts, "2026-11-09").items[0]?.detail).toBe("general waste + food, collected Tuesday");
    expect(binsFor(facts, "2026-11-03").items).toHaveLength(0);
    // Thursday 19:00 Tom is at five-a-side: only Priya is home.
    expect(recipientsHomeAt(facts, at("2026-11-05", 19, 30))).toEqual(["priya"]);
    expect(recipientsHomeAt(facts, at(MON, 19))).toEqual(["priya", "tom"]);
  });

  test("[PRO-4] dry for three hours or more and someone home: a washing suggestion that morning, shown not sent", () => {
    const mon = washingFor(facts, MON, at(MON, 7));
    expect(mon.items[0]?.title).toBe("Hang the washing out");
    expect(mon.items[0]?.reason).toBe("Dry until 2pm and you're both in all day");
    expect(mon.nudges).toHaveLength(0);
    expect(washingFor(facts, "2026-11-03", at("2026-11-03", 7)).items).toHaveLength(0);
    // Friday: dry until midday, so 7–12 is five hours: fine. At 10am only two hours are left.
    expect(washingFor(facts, "2026-11-06", at("2026-11-06", 10)).items).toHaveLength(0);
    // Nobody home: no suggestion.
    const empty: HouseFacts = { ...facts, events: [...facts.events, { id: "x", externalId: "x", title: "Away", start: at(MON, 6).toISOString(), end: at(MON, 20).toISOString(), allDay: false, attendees: ["priya", "tom"], away: ["priya", "tom"], work: false, soloWithKids: null, calendars: ["shared"] }] };
    expect(washingFor(empty, MON, at(MON, 7)).items).toHaveLength(0);
  });

  test("[PRO-5] the morning of a delivery that needs someone in brings a message; one that can be left does not", () => {
    const mon = arrivalsFor(facts, MON);
    expect(mon.items.map((i) => i.title)).toEqual(["Screwfix", "Ocado"]);
    expect(mon.nudges).toHaveLength(0);
    const tue = arrivalsFor(facts, "2026-11-03");
    expect(tue.nudges.map((n) => n.message)).toEqual(expect.arrayContaining(["Ocado delivery today, 7–8pm. Someone needs to be in."]));
  });

  test("[PRO-10] nursery inset days, parties and closures show under Tomorrow the day before, with who is covering or a warning", () => {
    const wed = nurseryFor(facts, "2026-11-04").items.find((i) => i.section === Section.tomorrow);
    expect(wed?.kind).toBe("event");
    expect(wed?.detail).toBe("Priya is covering");
    const thu = nurseryFor(facts, "2026-11-05").items.find((i) => i.section === Section.tomorrow);
    expect(thu?.kind).toBe("alert");
    expect(thu?.title).toBe("Nursery inset day tomorrow — nobody is covering yet");
  });

  test("[CAP-8] term dates, closures and session days show up on the day they matter", () => {
    expect(nurseryFor(facts, MON).items.find((i) => i.title === "Nursery")?.detail).toBe("Ivy and Noah");
    expect(nurseryFor(facts, "2026-11-04").items.find((i) => i.title === "Nursery")?.detail).toBe("Noah");
    expect(nurseryFor(facts, "2026-11-06").items.find((i) => i.title === "Nursery")).toBeUndefined();
    expect(nurseryFor(facts, "2026-11-06").items.find((i) => i.title === "Nursery inset day")).toBeDefined();
    expect(nurseryFor(facts, "2026-12-18").items.find((i) => i.title === "Last day of nursery term")).toBeDefined();
  });

  test("[CAP-7] regular chores set up once as rules appear on the right day", () => {
    expect(choresFor(facts, "2026-11-04").items.map((i) => i.title)).toEqual(["Water the plants"]);
    expect(choresFor(facts, "2026-11-03").items.map((i) => i.title)).toEqual(["Change the beds"]);
    expect(choresFor(facts, MON).items).toHaveLength(0);
  });

  test("[PRO-7][QA-7] three messages a day and quiet hours 9pm to 7am to start; anything over waits for the morning screen", async () => {
    const settings = await h.rt.system("test").household.personSettings({ person: "priya" });
    expect(settings.dailyMessageBudget).toBe(3);
    expect([settings.quietStartHour, settings.quietEndHour]).toEqual([21, 7]);
    expect(deliveryFor(settings, 2, at(MON, 12), TZ)).toBe("send");
    expect(deliveryFor(settings, 3, at(MON, 12), TZ)).toBe("over-budget");
    expect(deliveryFor(settings, 0, at(MON, 21, 30), TZ)).toBe("quiet");
    expect(inQuietHours(settings, at(MON, 6, 59), TZ)).toBe(true);
    expect(inQuietHours(settings, at(MON, 7), TZ)).toBe(false);
    expect(Object.values(NotificationStatus)).toContain("deferred");
  });

  test("[CAP-3] the app guesses tags from what you wrote", () => {
    expect(guessTags("Ring the plumber about the tap")).toEqual(["quick", "phone-call", "office-hours"]);
    expect(guessTags("Paint the shed door")).toEqual(expect.arrayContaining(["half-day", "daylight", "dry"]));
  });

  test("[PRV-4] the household knows the kids by first name and nursery days only", () => {
    const kids = facts.people.filter((p) => p.role === PersonRole.child);
    for (const k of kids) expect(Object.keys(k).sort()).toEqual(["id", "name", "nurseryDays", "role"]);
  });
});
