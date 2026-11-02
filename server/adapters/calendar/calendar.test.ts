import { Practice } from "@household/contracts";
import type { Hono } from "hono";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { TestHousehold } from "../../testing/household.ts";
import { householdWithApp, jobForKey, loginCookie, poll, storedShape } from "../../testing/http.ts";
import type { HttpEnv } from "../registry.ts";

let h: TestHousehold;
let app: Hono<HttpEnv>;

beforeAll(async () => {
  ({ h, app } = await householdWithApp());
});
afterAll(async () => h.close());

const push = (messageNumber: string, token: string = Practice.settings.CALENDAR_WEBHOOK_TOKEN, state = "exists") =>
  app.request("/webhooks/calendar", {
    method: "POST",
    headers: { "x-goog-channel-id": "chan-1", "x-goog-channel-token": token, "x-goog-resource-state": state, "x-goog-message-number": messageNumber, "x-goog-resource-id": "res-1" },
  });

describe("calendar webhook adapter", () => {
  test("[CH-2][CH-1][CH-6] a calendar change arrives as a message and re-plans only the day it touched", async () => {
    h.ports.calendar.upsert({ externalId: "g-new-dentist", title: "Dentist — Priya", start: "2026-11-04T10:00:00Z", end: "2026-11-04T10:30:00Z", allDay: false, attendees: ["priya"], away: ["priya"], work: false, soloWithKids: null });
    const res = await push("101");
    expect(res.status).toBe(200);
    const { messageId, job } = await jobForKey(h.rt, "calendar:chan-1:101");
    expect(job.status).toBe("succeeded");
    const shape = await storedShape(h.rt, messageId);
    expect(shape).toMatchObject({ person: null, channel: "webhook", attachments: [{ kind: "calendar-change", resourceState: "exists" }] });
    const plan = await poll(() => h.rt.system("test").plans.latest({ date: "2026-11-04" }));
    expect(JSON.stringify(plan.blocks)).toContain("Dentist — Priya");
    // The first sync copies every event, so its changed days are the whole week; a second, single edit touches one day.
    h.ports.calendar.upsert({ externalId: "g-new-dentist", title: "Dentist — Priya (moved)", start: "2026-11-04T11:00:00Z", end: "2026-11-04T11:30:00Z", allDay: false, attendees: ["priya"], away: ["priya"], work: false, soloWithKids: null });
    await push("102");
    const second = await jobForKey(h.rt, "calendar:chan-1:102");
    expect(second.job.toolCalls[0]?.output).toEqual({ changedDates: ["2026-11-04"] });
    const versions = await h.rt.system("test").plans.versions({ date: "2026-11-05" });
    const versionsOn4 = await h.rt.system("test").plans.versions({ date: "2026-11-04" });
    expect(versionsOn4.at(-1)?.trigger).toBe(`job:${second.job.id}`);
    expect(versions.every((v) => v.trigger !== `job:${second.job.id}`)).toBe(true);
  });

  test("[CH-4] the webhook firing again is one job, not two", async () => {
    await push("200");
    await push("200");
    const { messageId } = await jobForKey(h.rt, "calendar:chan-1:200");
    const jobs = (await h.rt.system("test").jobs.recentJobs()).filter((j) => j.messageId === messageId);
    expect(jobs).toHaveLength(1);
  });

  test("[PRV-6] the calendar webhook rejects a missing or wrong channel token", async () => {
    expect((await push("300", "wrong")).status).toBe(401);
    expect((await app.request("/webhooks/calendar", { method: "POST" })).status).toBe(401);
  });

  test("[HOME-1] a practice calendar edit flows through the same webhook path", async () => {
    const cookie = await loginCookie(app);
    const res = await app.request("/api/practice/calendar", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ upsert: { externalId: "g-practice-edit", title: "Parents' evening", start: "2026-11-02T17:00:00Z", end: "2026-11-02T18:00:00Z", attendees: ["priya", "tom"] } }),
    });
    const body = z.object({ jobId: z.string().nullable() }).parse(await res.json());
    expect(body.jobId).not.toBeNull();
    const plan = await poll(async () => {
      const p = await h.rt.system("test").plans.latest({ date: "2026-11-02" });
      return p !== null && JSON.stringify(p.blocks).includes("Parents' evening") ? p : null;
    });
    expect(plan.date).toBe("2026-11-02");
  });
});
