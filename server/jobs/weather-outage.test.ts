import { randomUUID } from "node:crypto";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { BlockType, Limits, Practice, TimerKind } from "@household/contracts";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { HttpEnv } from "../adapters/registry.ts";
import { acceptTimer } from "../coordinator/accept.ts";
import { OpenMeteoWeather } from "../integrations/weather-open-meteo.ts";
import type { WeatherSource } from "../ports.ts";
import type { TestHousehold } from "../testing/household.ts";
import { householdWithApp, jobForKey, poll } from "../testing/http.ts";
import { atLocal } from "../time.ts";
import { retryReplan } from "./effects.ts";
import { waitForJob } from "./launch.ts";

let h: TestHousehold;
let app: Hono<HttpEnv>;
let practiceWeather: WeatherSource;
const MON = "2026-11-02";
const TZ = "Europe/London";

beforeAll(async () => {
  ({ h, app } = await householdWithApp());
  practiceWeather = h.rt.ports.weather;
});
afterEach(() => {
  h.rt.ports.weather = practiceWeather;
  vi.restoreAllMocks();
});
afterAll(async () => h.close());

/** The real Open-Meteo adapter against a weather service that answers `answer` to every request. */
function downWeather(answer: () => Promise<Response>) {
  const calls: string[] = [];
  h.rt.ports.weather = new OpenMeteoWeather({
    fetch: async (url) => {
      calls.push(url);
      return answer();
    },
  });
  return calls;
}

/** Re-plan today through the catch-up timer (a plan and nothing else), and return the job and today's plan. */
async function replan(hour: number) {
  const a = await acceptTimer(h.rt, TimerKind.catchUpPlan, atLocal(MON, hour, 0, TZ));
  await waitForJob(a.jobId).catch(() => undefined);
  const job = await h.rt.system("test").jobs.job({ id: a.jobId });
  const plan = await h.rt.system("test").plans.latest({ date: MON });
  const context = plan?.blocks.find((b) => b.type === BlockType.context);
  return { job, plan, context: context?.type === BlockType.context ? context.line : "" };
}

const weatherWarnings = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.map((c: unknown[]) => String(c[0])).filter((line: string) => line.includes("weather-unavailable"));

describe("HOU-170: a weather outage never stops planning", () => {
  test("[PRO-4][HOME-2] Open-Meteo answering 503: the plan is made without weather, says so, and logs one warning with the status", async () => {
    const warn = vi.spyOn(console, "warn");
    const calls = downWeather(async () => new Response("Service Unavailable", { status: 503 }));
    const { job, plan, context } = await replan(8);
    expect(job?.status).toBe("succeeded");
    expect(plan?.blocks.some((b) => b.id === `washing:${MON}`)).toBe(false);
    expect(context).toContain("Forecast not available");
    // A short bounded retry, then no more calls for the rest of the week in this plan.
    // limit: weatherAttempts
    expect(calls).toHaveLength(Limits.weatherAttempts.value);
    const warnings = weatherWarnings(warn);
    expect(warnings).toHaveLength(1);
    expect(JSON.parse(warnings[0] ?? "{}")).toMatchObject({ event: "weather-unavailable", status: 503 });
  });

  test("[PRO-4][HOME-2] a weather request that times out: the plan is still made, without weather", async () => {
    downWeather(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const { job, plan, context } = await replan(9);
    expect(job?.status).toBe("succeeded");
    expect(plan?.blocks.some((b) => b.id === `washing:${MON}`)).toBe(false);
    expect(context).toContain("Forecast not available");
  });

  test("[PLT-3][PRO-4] with a forecast kept from earlier, an outage plans with that forecast", async () => {
    const good = await replan(10);
    expect(good.context).toContain("Dry until 2pm");
    expect((await h.rt.system("test").plans.forecast({ date: MON }))?.hours.length).toBeGreaterThan(0);
    downWeather(async () => new Response("", { status: 503 }));
    const { job, plan, context } = await replan(11);
    expect(job?.status).toBe("succeeded");
    expect(context).toContain("Dry until 2pm");
    expect(plan?.blocks.some((b) => b.id === `washing:${MON}`)).toBe(true);
  });

  test("[CAP-9] a record_arrival job whose re-plan fails still records the arrival, succeeds, and the re-plan is retried", async () => {
    const shopping = h.rt.ports.shopping;
    // Something in the re-plan breaks (here, composing the shop blocks), after the tool succeeded.
    h.rt.ports.shopping = Object.create(shopping, {
      connected: {
        get(): boolean {
          throw new Error("planner broke");
        },
      },
    });
    const email = {
      from: "Screwfix <orders@screwfix.com>",
      to: "priya@practice.home",
      subject: "Your Screwfix order is confirmed",
      text: "Thanks for your order SF-170.\nArriving Tuesday 3 November between 8am and 1pm.\n1x drill bits",
      messageId: `<sf-${randomUUID()}@screwfix.com>`,
    };
    try {
      const posted = await app.request("/webhooks/email", { method: "POST", headers: { "content-type": "application/json", "x-webhook-secret": Practice.settings.EMAIL_WEBHOOK_SECRET }, body: JSON.stringify(email) });
      expect(posted.status).toBe(200);
      const { job } = await jobForKey(h.rt, `email:${email.messageId}`);
      expect(job.status).toBe("succeeded");
      expect(job.error).toBeNull();
      expect(job.toolCalls).toContainEqual(expect.objectContaining({ tool: "record_arrival", output: expect.objectContaining({ recorded: true, shop: "Screwfix", expectedDate: "2026-11-03" }) }));
      expect(job.toolCalls).toContainEqual({ tool: "replan", input: { date: "2026-11-03" }, output: { failed: "planner broke", retrying: true } });
      expect(await poll(async () => (await h.rt.system("test").parcels.all()).find((a) => a.shop === "Screwfix" && a.expectedDate === "2026-11-03"))).toBeTruthy();
      // The retry is a durable workflow, waiting out its delay before it tries again.
      const pending = await DBOS.getWorkflowStatus(`${job.id}:replan:2026-11-03:job:${job.id}`);
      expect(pending?.status).toBe("PENDING");
      await DBOS.cancelWorkflow(`${job.id}:replan:2026-11-03:job:${job.id}`);
      await DBOS.cancelWorkflow(`${job.id}:replan:2026-11-02:job:${job.id}`);

      // Once the planner is back, the retry re-plans the day and the arrival is on it.
      h.rt.ports.shopping = shopping;
      const retried = await DBOS.startWorkflow(retryReplan, { workflowID: `test-retry-${randomUUID()}` })("2026-11-03", `job:${job.id}`, job.id, 10);
      expect(await retried.getResult()).toBe(true);
      const versions = await h.rt.system("test").plans.versions({ date: "2026-11-03" });
      expect(versions.at(-1)?.trigger).toBe(`job:${job.id}:retry`);
      expect(JSON.stringify(versions.at(-1)?.blocks)).toContain("Screwfix");
    } finally {
      h.rt.ports.shopping = shopping;
    }
  });

});
