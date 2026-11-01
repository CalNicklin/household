import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { testHousehold, type TestHousehold } from "../../testing/household.ts";
import * as schema from "./schema.ts";

/** HOU-152: copies stored before calendars were recorded (calendar_id '') go once the shared calendar has been read. */
let h: TestHousehold;
beforeAll(async () => {
  h = await testHousehold({ jobs: false });
});
afterAll(async () => h.close());

describe("[HOME-1] the first sync after calendars are recorded", () => {
  test("a sync that couldn't read the shared calendar keeps the old copies; one that read it drops them", async () => {
    await h.rt.dbs.calendar.insert(schema.events).values({ externalId: "legacy-1", title: "From before", start: new Date("2026-11-04T10:00:00Z"), end: new Date("2026-11-04T11:00:00Z") });
    const api = h.rt.system("test");
    const calendarIds = h.ports.calendar.calendars.map((c) => c.calendarId);
    const day = { from: "2026-11-04T00:00:00Z", to: "2026-11-05T00:00:00Z" };
    await api.calendar.applySync({ upserts: [], deletedExternalIds: [], syncTokens: {}, calendarIds, sharedRead: false });
    expect((await api.calendar.between(day)).map((e) => e.title)).toContain("From before");
    const out = await api.calendar.applySync({ upserts: [], deletedExternalIds: [], syncTokens: {}, calendarIds, sharedRead: true });
    expect((await api.calendar.between(day)).map((e) => e.title)).not.toContain("From before");
    expect(out.changedDates).toEqual(["2026-11-04"]);
  });
});
