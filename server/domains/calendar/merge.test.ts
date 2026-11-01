import { CalendarOwnerKind, PersonRole } from "@household/contracts";
import { describe, expect, test } from "vitest";
import type { HouseFacts } from "../../rules/day.ts";
import { babysitterFor } from "../../rules/nudges.ts";
import { mergeCopies, type StoredCopy } from "./merge.ts";

/** HOME-1: copies of one event on several calendars are one event with every owner on it. */
const copy = (owner: string, eventId: string, over: Partial<StoredCopy> = {}): StoredCopy => {
  const calendarId = owner === CalendarOwnerKind.shared ? "family@example.com" : `${owner}@example.com`;
  const people = owner === CalendarOwnerKind.shared ? [] : [owner];
  return {
    id: `${calendarId}/${eventId}`,
    externalId: `${calendarId}/${eventId}`,
    calendarId,
    owner,
    uid: null,
    busy: false,
    title: "Event",
    start: "2026-11-10T19:30:00.000Z",
    end: "2026-11-10T23:00:00.000Z",
    allDay: false,
    attendees: people,
    away: people,
    work: false,
    soloWithKids: null,
    ...over,
  };
};

describe("[HOME-1] the house reads several calendars as one", () => {
  test("an invite on Priya's and Tom's calendars (same iCalUID) is one event with both on it", () => {
    const events = mergeCopies([copy("tom", "inv", { uid: "dinner@google.com", title: "Dinner" }), copy("priya", "inv", { uid: "dinner@google.com", title: "Dinner" })]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ externalId: "dinner@google.com", title: "Dinner", attendees: ["priya", "tom"], away: ["priya", "tom"], calendars: ["priya", "tom"] });
  });

  test("a copy on the shared calendar joins it too, and the shared calendar's wording wins", () => {
    const events = mergeCopies([
      copy("priya", "a", { uid: "u1", title: "Sam's (mine)" }),
      copy(CalendarOwnerKind.shared, "a", { uid: "u1", title: "Dinner at Sam's", attendees: ["tom"], away: ["tom"], soloWithKids: null, work: true }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ title: "Dinner at Sam's", attendees: ["tom", "priya"], away: ["tom", "priya"], work: true, calendars: ["shared", "priya"] });
  });

  test("each instance of a recurring event is its own event; different events with no uid never merge", () => {
    const events = mergeCopies([
      copy("priya", "r1", { uid: "swim@google.com@2026-11-03T17:00:00.000Z", start: "2026-11-03T17:00:00.000Z", end: "2026-11-03T18:00:00.000Z" }),
      copy("tom", "r1", { uid: "swim@google.com@2026-11-03T17:00:00.000Z", start: "2026-11-03T17:00:00.000Z", end: "2026-11-03T18:00:00.000Z" }),
      copy("priya", "r2", { uid: "swim@google.com@2026-11-10T17:00:00.000Z", start: "2026-11-10T17:00:00.000Z", end: "2026-11-10T18:00:00.000Z" }),
      copy("priya", "x"),
      copy("tom", "y"),
    ]);
    expect(events.map((e) => [e.externalId, e.calendars])).toEqual([
      ["swim@google.com@2026-11-03T17:00:00.000Z", ["priya", "tom"]],
      ["swim@google.com@2026-11-10T17:00:00.000Z", ["priya"]],
      ["priya@example.com/x", ["priya"]],
      ["tom@example.com/y", ["tom"]],
    ]);
  });

  test("a free/busy-only block joins a full event at exactly the same time on another calendar, else stands alone as Busy", () => {
    const joined = mergeCopies([copy("tom", "b", { busy: true, title: "Busy" }), copy("priya", "inv", { uid: "u2", title: "Theatre" })]);
    expect(joined).toHaveLength(1);
    expect(joined[0]).toMatchObject({ title: "Theatre", attendees: ["priya", "tom"], away: ["priya", "tom"], calendars: ["priya", "tom"] });
    const alone = mergeCopies([copy("tom", "b", { busy: true, title: "Busy", start: "2026-11-10T09:00:00.000Z", end: "2026-11-10T10:00:00.000Z" }), copy("priya", "inv", { uid: "u2" })]);
    expect(alone.map((e) => [e.title, e.attendees])).toEqual([
      ["Busy", ["tom"]],
      ["Event", ["priya"]],
    ]);
  });

  test("[PRO-1] the babysitter rule sees an invite on both personal calendars as both of them out", () => {
    const facts: HouseFacts = {
      timeZone: "Europe/London",
      latitude: 51.5,
      longitude: -0.1,
      people: [
        { id: "priya", name: "Priya", role: PersonRole.adult, nurseryDays: [] },
        { id: "tom", name: "Tom", role: PersonRole.adult, nurseryDays: [] },
      ],
      events: [],
      rules: [],
      nurseryTerms: [],
      nurseryEvents: [],
      sitters: [{ id: "s1", name: "Jess", knownFreeDays: [] }],
      sitterBookings: [],
      arrivals: [],
      mode: null,
      forecast: {},
    };
    const invite = [copy("priya", "inv", { uid: "u3", title: "Dinner" }), copy("tom", "inv", { uid: "u3", title: "Dinner" })];
    const merged = babysitterFor({ ...facts, events: mergeCopies(invite) }, "2026-11-05");
    expect(merged.items.map((i) => i.ref)).toEqual(["sitter:2026-11-10"]);
    // Two separate events (one each, no shared uid) are not "both going to one evening event".
    const separate = babysitterFor({ ...facts, events: mergeCopies(invite.map((c) => ({ ...c, uid: null }))) }, "2026-11-05");
    expect(separate.items).toHaveLength(0);
  });
});
