import { boolean, date, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, id } from "../../db/columns.ts";

/** PRV-3: shop and date only. The email itself is never stored. */
export const arrivals = pgTable(
  "arrivals",
  {
    id: id(),
    shop: text("shop").notNull(),
    expectedDate: date("expected_date").notNull(),
    window: text("time_window"),
    needsSomeoneIn: boolean("needs_someone_in").notNull().default(false),
    person: text("person"),
    sourceKey: text("source_key").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("arrivals_source").on(t.sourceKey)],
);
