import { ActorKind, Domain } from "@household/contracts";
import { closePool, connectDomain, type DomainDb } from "./db/index.ts";
import * as backlog from "./domains/backlog/schema.ts";
import { backlogRouter } from "./domains/backlog/router.ts";
import * as calendar from "./domains/calendar/schema.ts";
import { calendarRouter } from "./domains/calendar/router.ts";
import * as health from "./domains/health/schema.ts";
import { healthRouter } from "./domains/health/router.ts";
import * as household from "./domains/household/schema.ts";
import { householdRouter } from "./domains/household/router.ts";
import * as jobs from "./domains/jobs/schema.ts";
import { jobsRouter } from "./domains/jobs/router.ts";
import * as learning from "./domains/learning/schema.ts";
import { learningRouter } from "./domains/learning/router.ts";
import * as lists from "./domains/lists/schema.ts";
import { listsRouter } from "./domains/lists/router.ts";
import * as parcels from "./domains/parcels/schema.ts";
import { parcelsRouter } from "./domains/parcels/router.ts";
import * as plans from "./domains/plans/schema.ts";
import { plansRouter } from "./domains/plans/router.ts";
import * as shopping from "./domains/shopping/schema.ts";
import { shoppingRouter } from "./domains/shopping/router.ts";
import * as wellbeing from "./domains/wellbeing/schema.ts";
import { wellbeingRouter } from "./domains/wellbeing/router.ts";
import type { Env } from "./env.ts";
import { LiveBus } from "./live/bus.ts";
import type { Ports } from "./ports.ts";
import { type Actor, createCallerFactory, router } from "./trpc.ts";

export const schemas = { household, calendar, backlog, plans, parcels, learning, wellbeing, jobs, health, shopping, lists } as const satisfies Record<Domain, Record<string, unknown>>;

type Dbs = { [D in Domain]: DomainDb<(typeof schemas)[D]> };

export function connectAll(env: Env): Dbs {
  return {
    household: connectDomain(env.DATABASE_URL, env.DB_PREFIX, Domain.household, household),
    calendar: connectDomain(env.DATABASE_URL, env.DB_PREFIX, Domain.calendar, calendar),
    backlog: connectDomain(env.DATABASE_URL, env.DB_PREFIX, Domain.backlog, backlog),
    plans: connectDomain(env.DATABASE_URL, env.DB_PREFIX, Domain.plans, plans),
    parcels: connectDomain(env.DATABASE_URL, env.DB_PREFIX, Domain.parcels, parcels),
    learning: connectDomain(env.DATABASE_URL, env.DB_PREFIX, Domain.learning, learning),
    wellbeing: connectDomain(env.DATABASE_URL, env.DB_PREFIX, Domain.wellbeing, wellbeing),
    jobs: connectDomain(env.DATABASE_URL, env.DB_PREFIX, Domain.jobs, jobs),
    health: connectDomain(env.DATABASE_URL, env.DB_PREFIX, Domain.health, health),
    shopping: connectDomain(env.DATABASE_URL, env.DB_PREFIX, Domain.shopping, shopping),
    lists: connectDomain(env.DATABASE_URL, env.DB_PREFIX, Domain.lists, lists),
  };
}

/** One router per domain (CODE-5), each built over its own database only. */
function buildAppRouter(dbs: Dbs, timeZone: string, healthOwner: string | null) {
  return router({
    household: householdRouter(dbs.household),
    calendar: calendarRouter(dbs.calendar, timeZone),
    backlog: backlogRouter(dbs.backlog),
    plans: plansRouter(dbs.plans),
    parcels: parcelsRouter(dbs.parcels),
    learning: learningRouter(dbs.learning),
    wellbeing: wellbeingRouter(dbs.wellbeing),
    jobs: jobsRouter(dbs.jobs),
    health: healthRouter(dbs.health, healthOwner),
    shopping: shoppingRouter(dbs.shopping),
    lists: listsRouter(dbs.lists),
  });
}
type AppRouter = ReturnType<typeof buildAppRouter>;
const callerFactory = (r: AppRouter) => createCallerFactory(r);
export type Api = ReturnType<ReturnType<typeof callerFactory>>;

export type Runtime = {
  env: Env;
  ports: Ports;
  dbs: Dbs;
  bus: LiveBus;
  timeZone: string;
  /** A tRPC caller acting as `actor`: the only way code outside a domain reads or writes it. */
  as(actor: Actor): Api;
  system(reason: string): Api;
  close(): Promise<void>;
};

export async function createRuntime(env: Env, ports: Ports): Promise<Runtime> {
  const dbs = connectAll(env);
  const settings = await dbs.household.query.settings.findFirst();
  const timeZone = settings?.timezone ?? "Europe/London";
  const healthOwner = settings?.healthOwner ?? null;
  const appRouter = buildAppRouter(dbs, timeZone, healthOwner);
  const factory = callerFactory(appRouter);
  const bus = new LiveBus();
  const as = (actor: Actor): Api => factory({ actor, now: ports.clock.now(), publish: (t) => bus.publish(t) });
  return {
    env,
    ports,
    dbs,
    bus,
    timeZone,
    as,
    system: (reason) => as({ kind: ActorKind.system, reason }),
    close: async () => {
      await Promise.all(Object.values(dbs).map((db) => closePool(db.$client)));
    },
  };
}
