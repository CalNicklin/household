import { type Arrival, zArrival, zArrivalInput, zDateRangeInput, zIdInput } from "@household/contracts";
import { and, eq, gte, lte } from "drizzle-orm";
import { z } from "zod";
import type { DomainDb } from "../../db/index.ts";
import { iso } from "../../db/map.ts";
import { actorProcedure, personProcedure, readProcedure, router } from "../../trpc.ts";
import * as schema from "./schema.ts";

export type ParcelsDb = DomainDb<typeof schema>;

const toArrival = (r: typeof schema.arrivals.$inferSelect): Arrival => ({
  id: r.id,
  shop: r.shop,
  expectedDate: r.expectedDate,
  window: r.window,
  needsSomeoneIn: r.needsSomeoneIn,
  person: r.person,
  createdAt: iso(r.createdAt),
});

export function parcelsRouter(db: ParcelsDb) {
  return router({
    /** CAP-9: an Arriving row from an order confirmation; the source key keeps it to one row. */
    record: actorProcedure.input(zArrivalInput).output(zArrival).mutation(async ({ ctx, input }) => {
      const [row] = await db.insert(schema.arrivals).values({ ...input, createdAt: ctx.now }).onConflictDoUpdate({ target: schema.arrivals.sourceKey, set: input }).returning();
      if (row === undefined) throw new Error("insert failed");
      ctx.publish("arrivals");
      return toArrival(row);
    }),
    between: readProcedure.input(zDateRangeInput).output(z.array(zArrival)).query(async ({ input }) =>
      (await db.select().from(schema.arrivals).where(and(gte(schema.arrivals.expectedDate, input.from.slice(0, 10)), lte(schema.arrivals.expectedDate, input.to.slice(0, 10))))).map(toArrival),
    ),
    all: readProcedure.output(z.array(zArrival)).query(async () => (await db.select().from(schema.arrivals)).map(toArrival)),
    remove: personProcedure.input(zIdInput).mutation(async ({ ctx, input }) => {
      await db.delete(schema.arrivals).where(eq(schema.arrivals.id, input.id));
      ctx.publish("arrivals");
    }),
  });
}
