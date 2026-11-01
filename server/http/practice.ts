import { TimerKind, zTimerKind } from "@household/contracts";
import type { Hono } from "hono";
import { z } from "zod";
import { PRACTICE_START } from "../../practice/data.ts";
import { InMemoryEpisodicMemory, PracticeCalendar, PracticeClock, PracticeMessenger } from "../../practice/fakes.ts";
import { truncateAndSeed } from "../../practice/seed.ts";
import { acceptTimer } from "../coordinator/accept.ts";
import { NoShoppingHelper } from "../integrations/shopping-helper.ts";
import type { HttpEnv } from "../adapters/registry.ts";
import type { Runtime } from "../runtime.ts";

/** QA-9 / FB-5: practice-household controls for previews and e2e. Never mounted for the real house. */
export function practiceRoutes(rt: Runtime) {
  // The practice household's own helper, put back by reset after a journey disconnects it.
  const helper = rt.ports.shopping;
  return (app: Hono<HttpEnv>) => {
    /** HOU-157: run the practice household like the real house with no shopping helper, or back again. */
    app.post("/api/practice/shopping-helper", async (c) => {
      if (!(rt.ports.clock instanceof PracticeClock)) return c.json({ error: "not the practice household" }, 400);
      const body = z.object({ connected: z.boolean() }).parse(await c.req.json());
      rt.ports.shopping = body.connected ? helper : new NoShoppingHelper();
      return c.json({ connected: rt.ports.shopping.connected });
    });
    app.post("/api/practice/clock", async (c) => {
      const body = z.object({ at: z.iso.datetime({ offset: true }), frozen: z.boolean().optional() }).parse(await c.req.json());
      if (!(rt.ports.clock instanceof PracticeClock)) return c.json({ error: "not a practice clock" }, 400);
      rt.ports.clock.set(body.at, body.frozen ?? false);
      rt.bus.publish("plan");
      return c.json({ now: rt.ports.clock.now().toISOString() });
    });
    app.post("/api/practice/timer", async (c) => {
      const body = z.object({ timer: zTimerKind.default(TimerKind.morningPlan), at: z.iso.datetime({ offset: true }).optional() }).parse(await c.req.json());
      const accepted = await acceptTimer(rt, body.timer, body.at === undefined ? rt.ports.clock.now() : new Date(body.at));
      return c.json(accepted);
    });
    /**
     * FB-5 / FB-6: a fresh practice household in place, for previews and e2e. With `empty`, a
     * brand-new house instead (HOU-149): the people and logins only, and no plan until someone looks.
     */
    app.post("/api/practice/reset", async (c) => {
      const body = z.object({ at: z.iso.datetime({ offset: true }).default(PRACTICE_START), empty: z.boolean().default(false) }).parse(await c.req.json().catch(() => ({})));
      const ports = rt.ports;
      if (!(ports.clock instanceof PracticeClock)) return c.json({ error: "not the practice household" }, 400);
      ports.clock.set(body.at, true);
      if (ports.calendar instanceof PracticeCalendar) {
        if (body.empty) ports.calendar.clear();
        else ports.calendar.reset();
      }
      if (ports.messenger instanceof PracticeMessenger) ports.messenger.sent.length = 0;
      if (ports.memory instanceof InMemoryEpisodicMemory) ports.memory.banks.clear();
      ports.shopping = helper;
      await truncateAndSeed(rt.env, new Date(body.at), { empty: body.empty });
      if (body.empty) {
        ports.clock.set(body.at, false);
        rt.bus.publish("plan");
        return c.json({ jobId: null });
      }
      const accepted = await acceptTimer(rt, TimerKind.morningPlan, new Date(body.at));
      ports.clock.set(body.at, false);
      rt.bus.publish("plan");
      return c.json(accepted);
    });
    app.get("/api/practice/job/:id", async (c) => c.json(await rt.system("practice").jobs.job({ id: c.req.param("id") })));
    app.get("/api/practice/now", (c) => c.json({ now: rt.ports.clock.now().toISOString() }));
  };
}
