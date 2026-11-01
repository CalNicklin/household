import {
  ActorKind,
  type List,
  type ListItem,
  ListItemSource,
  ListWriteOutcome,
  type ListWriteResult,
  zIdInput,
  zListCreateInput,
  zListImportInput,
  zListImportOutput,
  zListItem,
  zListItemAddInput,
  zListItemCheckInput,
  zListItemRenameInput,
  zListsView,
  zListUpdateInput,
  zListWriteResult,
  zPersonInput,
} from "@household/contracts";
import { and, asc, eq, ne, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import type { DomainDb } from "../../db/index.ts";
import { iso } from "../../db/map.ts";
import { actingPerson, actorProcedure, forbid, personProcedure, readProcedure, router, systemProcedure } from "../../trpc.ts";
import * as schema from "./schema.ts";

export type ListsDb = DomainDb<typeof schema>;
type ItemRow = typeof schema.items.$inferSelect;

const toItem = (r: ItemRow): ListItem => ({
  id: r.id,
  listId: r.listId,
  text: r.text,
  checked: r.checked,
  position: r.position,
  createdBy: r.createdBy,
  source: r.source,
  createdAt: iso(r.createdAt),
});

/** CAP-6: the duplicate rule, the same expression as the unique index (case and surrounding spaces ignored). */
const sameText = (text: string): SQL => sql`lower(btrim(${schema.items.text})) = lower(btrim(${text}))`;

/** Postgres refused a row because the unique index already holds it (a race the router's own check lost). */
const zUniqueViolation = z.object({ code: z.literal("23505") });
function isUniqueViolation(e: unknown): boolean {
  if (zUniqueViolation.safeParse(e).success) return true;
  const cause = z.object({ cause: z.unknown() }).safeParse(e);
  return cause.success && zUniqueViolation.safeParse(cause.data.cause).success;
}

/**
 * CAP-6: the household's shared lists. Anything said or typed can add to them, and every write
 * publishes `lists` so both phones and the iPad show it straight away.
 *
 * PRV-1, by actor: a person can do anything to the lists from the Lists screen. A job (the agent) can
 * only add an item, from the message it is handling, for the person who said it. It can never
 * delete, rename, tick or untick an item, or touch a list itself.
 */
export function listsRouter(db: ListsDb) {
  const itemById = async (id: string): Promise<ItemRow> => {
    const row = await db.query.items.findFirst({ where: eq(schema.items.id, id) });
    if (row === undefined) forbid(`no list item ${id}`);
    return row;
  };
  const duplicateOf = (listId: string, text: string, except: string | null) =>
    db.query.items.findFirst({ where: and(eq(schema.items.listId, listId), sameText(text), except === null ? undefined : ne(schema.items.id, except)) });
  const board = async (): Promise<List[]> => {
    const lists = await db.select().from(schema.lists).orderBy(asc(schema.lists.position), asc(schema.lists.createdAt), asc(schema.lists.id));
    const items = await db.select().from(schema.items).orderBy(asc(schema.items.position), asc(schema.items.createdAt), asc(schema.items.id));
    return lists.map((l) => ({ id: l.id, name: l.name, emoji: l.emoji, position: l.position, createdAt: iso(l.createdAt), items: items.filter((i) => i.listId === l.id).map(toItem) }));
  };

  return router({
    list: readProcedure.output(zListsView).query(board),

    createList: personProcedure.input(zListCreateInput).output(zIdInput).mutation(async ({ ctx, input }) => {
      const [last] = await db.select({ position: sql<number>`coalesce(max(${schema.lists.position}), -1)::int` }).from(schema.lists);
      const [row] = await db
        .insert(schema.lists)
        .values({ name: input.name, emoji: input.emoji, position: (last?.position ?? -1) + 1, createdAt: ctx.now })
        .returning({ id: schema.lists.id });
      if (row === undefined) throw new Error("insert failed");
      ctx.publish("lists");
      return row;
    }),

    /** Rename a list or change its emoji. */
    updateList: personProcedure.input(zListUpdateInput).mutation(async ({ ctx, input }) => {
      const patch = { ...(input.name === undefined ? {} : { name: input.name }), ...(input.emoji === undefined ? {} : { emoji: input.emoji }) };
      if (Object.keys(patch).length === 0) return;
      const updated = await db.update(schema.lists).set(patch).where(eq(schema.lists.id, input.id)).returning({ id: schema.lists.id });
      if (updated.length === 0) forbid(`no list ${input.id}`);
      ctx.publish("lists");
    }),

    /** The list and everything on it, for everyone. */
    removeList: personProcedure.input(zIdInput).mutation(async ({ ctx, input }) => {
      await db.delete(schema.lists).where(eq(schema.lists.id, input.id));
      ctx.publish("lists");
    }),

    addItem: actorProcedure
      .input(zListItemAddInput)
      .output(zListWriteResult)
      .mutation(async ({ ctx, input }): Promise<ListWriteResult> => {
        const author = actingPerson(ctx.actor);
        if (author === null) forbid("PRV-1: a list item must come from a person");
        const job = ctx.actor.kind === ActorKind.agent ? ctx.actor : null;
        if (job !== null && job.message !== input.sourceMessage) forbid("PRV-1: a job can only add what the message it is handling asked for");
        const fromJob = job !== null;
        const list = await db.query.lists.findFirst({ where: eq(schema.lists.id, input.listId) });
        if (list === undefined) forbid(`no list ${input.listId}`);
        const existing = await duplicateOf(list.id, input.text, null);
        if (existing !== undefined) return { outcome: ListWriteOutcome.duplicate, item: toItem(existing) };
        const [last] = await db
          .select({ position: sql<number>`coalesce(max(${schema.items.position}), -1)::int` })
          .from(schema.items)
          .where(eq(schema.items.listId, list.id));
        try {
          const [row] = await db
            .insert(schema.items)
            .values({
              listId: list.id,
              text: input.text,
              position: (last?.position ?? -1) + 1,
              createdBy: author,
              source: fromJob ? ListItemSource.agent : ListItemSource.person,
              sourceMessage: fromJob ? input.sourceMessage : null,
              createdAt: ctx.now,
            })
            .returning();
          if (row === undefined) throw new Error("insert failed");
          ctx.publish("lists");
          return { outcome: ListWriteOutcome.added, item: toItem(row) };
        } catch (e) {
          if (!isUniqueViolation(e)) throw e;
          const winner = await duplicateOf(list.id, input.text, null);
          if (winner === undefined) throw e;
          return { outcome: ListWriteOutcome.duplicate, item: toItem(winner) };
        }
      }),

    /** Tick or untick. Ticked items stay on the list, struck through. */
    setChecked: personProcedure.input(zListItemCheckInput).output(zListItem).mutation(async ({ ctx, input }) => {
      const [row] = await db.update(schema.items).set({ checked: input.checked }).where(eq(schema.items.id, input.id)).returning();
      if (row === undefined) forbid(`no list item ${input.id}`);
      ctx.publish("lists");
      return toItem(row);
    }),

    /** Rename an item. Fixing its capitalisation is fine; renaming it onto another item on the same list is not. */
    renameItem: personProcedure
      .input(zListItemRenameInput)
      .output(zListWriteResult)
      .mutation(async ({ ctx, input }): Promise<ListWriteResult> => {
        const item = await itemById(input.id);
        const clash = await duplicateOf(item.listId, input.text, item.id);
        if (clash !== undefined) return { outcome: ListWriteOutcome.duplicate, item: toItem(item) };
        try {
          const [row] = await db.update(schema.items).set({ text: input.text }).where(eq(schema.items.id, item.id)).returning();
          if (row === undefined) throw new Error("update failed");
          ctx.publish("lists");
          return { outcome: ListWriteOutcome.renamed, item: toItem(row) };
        } catch (e) {
          if (!isUniqueViolation(e)) throw e;
          return { outcome: ListWriteOutcome.duplicate, item: toItem(item) };
        }
      }),

    removeItem: personProcedure.input(zIdInput).mutation(async ({ ctx, input }) => {
      await db.delete(schema.items).where(eq(schema.items.id, input.id));
      ctx.publish("lists");
    }),

    /**
     * The one-off copy of Family Lists, as the system. Order, ticks and emoji are kept; nobody is named
     * as the author. It refuses to run over lists that already exist, so it can never copy twice.
     */
    importLists: systemProcedure
      .input(zListImportInput)
      .output(zListImportOutput)
      .mutation(async ({ ctx, input }) => {
        const counts = await db.transaction(async (tx) => {
          const [present] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.lists);
          if ((present?.n ?? 0) > 0) forbid("the lists already hold something; the import only runs once, into empty lists");
          let items = 0;
          for (const l of input.lists) {
            const [row] = await tx.insert(schema.lists).values({ name: l.name, emoji: l.emoji, position: l.position, createdAt: new Date(l.createdAt) }).returning({ id: schema.lists.id });
            if (row === undefined) throw new Error("insert failed");
            if (l.items.length === 0) continue;
            await tx.insert(schema.items).values(
              l.items.map((i) => ({ listId: row.id, text: i.text, checked: i.checked, position: i.position, createdBy: null, source: ListItemSource.import, sourceMessage: null, createdAt: new Date(i.createdAt) })),
            );
            items += l.items.length;
          }
          return { lists: input.lists.length, items };
        });
        ctx.publish("lists");
        return counts;
      }),

    /** PRV-7: the items a person added. */
    exportPerson: systemProcedure.input(zPersonInput).query(async ({ input }) => ({
      items: (await db.select().from(schema.items).where(eq(schema.items.createdBy, input.person))).map(toItem),
    })),
    /** PRV-7: the lists are the house's, so the items stay; who wrote them is forgotten. */
    deletePerson: systemProcedure.input(zPersonInput).mutation(async ({ input }) => {
      await db.update(schema.items).set({ createdBy: null }).where(eq(schema.items.createdBy, input.person));
    }),
  });
}
