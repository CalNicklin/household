import { createTool } from "@mastra/core/tools";
import { ActionKind, type BacklogTag, Limits, ListWriteOutcome, LongTool, type ModeKind as Mode, ModeKind, Urgency, zActionKind, zBacklogTag } from "@household/contracts";
import { z } from "zod";
import { gatherFacts, oneThingCandidates } from "../planner/gather.ts";
import { inQuietHours } from "../rules/budget.ts";
import { adultsOf, contextLine, eventsOn } from "../rules/day.ts";
import { parseOrder } from "../rules/orders.ts";
import { guessTags } from "../rules/tags.ts";
import { dayIn } from "../rules/when.ts";
import { addLocalDays, clock, localDate, longDate, nextLocalMidnight } from "../time.ts";
import { respond, subjectFor } from "./respond.ts";
import type { JobScope } from "./scope.ts";

// limit: defaultQuietStartHour
// limit: defaultQuietEndHour
const personDefaults = { quietStartHour: Limits.defaultQuietStartHour.value, quietEndHour: Limits.defaultQuietEndHour.value };

const NOTHING_PRESSING = { title: "Nothing pressing today", why: "No rule, calendar entry or quick backlog job needs doing now." } as const;

/** The household's tools. Each runs as the agent actor for this job's person (PRV-1 is enforced by the routers). */
export function houseTools(scope: JobScope) {
  const { rt, api } = scope;
  const tz = rt.timeZone;
  const today = () => localDate(rt.ports.clock.now(), tz);
  const record = <I, O>(tool: string, fn: (input: I) => Promise<O>) => async (input: I): Promise<O> => {
    const output = await fn(input);
    scope.toolCalls.push({ tool, input, output });
    return output;
  };
  const replanToday = () => {
    if (!scope.effects.replan.includes(today())) scope.effects.replan.push(today());
  };

  const capture = createTool({
    id: "capture",
    description: "Put a thought on the shared backlog: a job with no date, including fixing, setting up, booking or buying anything that is not groceries ('get the printer working', 'buy a new kettle'). One sentence is one item unless it clearly lists separate jobs. Guess tags for what it needs.",
    inputSchema: z.object({ text: z.string().min(1), tags: z.array(zBacklogTag).optional() }),
    execute: record("capture", async (input: { text: string; tags?: BacklogTag[] | undefined }) => {
      const hints = await rt.system("tags").household.tagHints();
      const tags = input.tags !== undefined && input.tags.length > 0 ? input.tags : guessTags(input.text, hints);
      const index = scope.toolCalls.filter((c) => c.tool === "capture").length;
      const item = await api.backlog.create({ text: input.text, tags, createdVia: scope.channel, sourceMessage: scope.messageId, index });
      // HOU-149: today's plan says whether the backlog is empty ("Getting started"), so redraw it now.
      replanToday();
      return { id: item.id, tags: item.tags, say: `Added to the backlog: ${item.text}.` };
    }),
  });

  const shop = createTool({
    id: "shop",
    description: "Groceries for the weekly supermarket shop ('we're out of oat milk and bread'), one item each. Never a job, a repair or a set-up, and never pieces of a sentence about something to do: that is capture.",
    inputSchema: z.object({ items: z.array(z.string().min(1)).min(1) }),
    execute: record("shop", async (input: { items: string[] }) => {
      const ids: string[] = [];
      for (const item of input.items) {
        const request = await api.shopping.request({ item, sourceMessage: `${scope.messageId}:${item}` });
        scope.effects.long.push({ tool: LongTool.shop, requestId: request.id, sku: null });
        ids.push(request.id);
      }
      // HOU-148: with no helper connected nothing will be looked for, so it says the request is saved.
      if (!rt.ports.shopping.connected) return { requests: ids, added: false, saved: true, say: `Saved ${input.items.join(" and ")} for when shopping is connected.` };
      // Nothing is in the basket yet: the helper adds it afterwards, or asks if there's no exact match (AUT-3).
      return { requests: ids, added: false, say: `I'll put ${input.items.join(" and ")} in the next shop. The home screen will show which product once it's in.` };
    }),
  });

  /**
   * CAP-6: add one item to a shared list in the lists domain. The router lets a job only add, from the
   * message it is handling (PRV-1); it never creates a list or changes what is already there.
   */
  const addToList = createTool({
    id: "add_to_list",
    description: "Add one item to one of the household's shared lists, named by the person: 'add batteries to the shopping list', 'add wrapping paper to the presents list'. Groceries with no list named ('we're out of oat milk', 'add it to the shop') go to shop instead.",
    inputSchema: z.object({ list: z.string(), item: z.string().min(1) }),
    execute: record("add_to_list", async (input: { list: string; item: string }) => {
      const wanted = input.list.trim().toLowerCase().replace(/\s+list$/, "");
      const lists = await api.lists.list();
      const match = lists.find((l) => l.name.toLowerCase() === wanted) ?? lists.find((l) => l.name.toLowerCase().includes(wanted));
      if (match === undefined) return { say: `There's no ${input.list} list. You can start one on the Lists screen.` };
      const result = await api.lists.addItem({ listId: match.id, text: input.item, sourceMessage: scope.messageId });
      if (result.outcome === ListWriteOutcome.duplicate) return { id: result.item.id, say: `${result.item.text} is already on ${match.name}${result.item.checked ? ", ticked" : ""}.` };
      return { id: result.item.id, say: `Added ${result.item.text} to ${match.name}.` };
    }),
  });

  const setMode = createTool({
    id: "set_mode",
    description: "Set the house's day: slow, sick, away or normal. Applies to the whole house until midnight unless extended.",
    inputSchema: z.object({ mode: z.enum(ModeKind), extend: z.string().nullable().optional() }),
    execute: record("set_mode", async (input: { mode: Mode; extend?: string | null | undefined }) => {
      const now = rt.ports.clock.now();
      const midnight = nextLocalMidnight(now, tz);
      const endsAt = input.mode === ModeKind.normal ? now : input.extend === "tomorrow" ? new Date(midnight.getTime() + 86_400_000) : midnight;
      await api.household.setMode({ mode: input.mode, endsAt: endsAt.toISOString() });
      replanToday();
      if (input.extend === "tomorrow") scope.effects.replan.push(addLocalDays(today(), 1));
      const until = input.extend === "tomorrow" ? "the end of tomorrow" : "midnight";
      return { say: input.mode === ModeKind.normal ? "Back to a normal day." : `${input.mode === ModeKind.sick ? "Sick" : input.mode === ModeKind.away ? "Away" : "Slow"} day until ${until}. I've made today smaller.` };
    }),
  });

  const whatNow = createTool({
    id: "what_now",
    description: "The one thing worth doing now, with its reason. Use it for 'if I do one thing, what should it be?'. Answer with that one thing; never a list, never a question.",
    inputSchema: z.object({}),
    execute: record("what_now", async () => {
      const date = today();
      const facts = await gatherFacts(rt, date, 2);
      const closed = new Set((await api.plans.responsesOn({ date })).map((r) => r.ref));
      const now = rt.ports.clock.now();
      const [first] = await oneThingCandidates(rt, facts, date, now, closed, scope.person);
      // HOU-149: the thin-house fallback waits out the asker's quiet hours (PRO-7); nobody should be told to ring someone at 11pm.
      const quiet = inQuietHours(scope.person === null ? personDefaults : await rt.system("what-now").household.personSettings({ person: scope.person }), now, tz);
      const best = first?.fallback === true && quiet ? undefined : first;
      // HOU-149: a thin house still gets one plain answer, never an error or a list.
      if (best === undefined) return { ref: null, title: NOTHING_PRESSING.title, why: NOTHING_PRESSING.why, say: `${NOTHING_PRESSING.title}. ${NOTHING_PRESSING.why}` };
      return { ref: best.ref, title: best.title, why: best.why, say: `${best.title}. ${best.why}` };
    }),
  });

  const respondTool = createTool({
    id: "respond",
    description: "Done, not today, snooze or accept on something on the screen, by its ref.",
    inputSchema: z.object({ ref: z.string(), action: zActionKind, value: z.string().nullable().optional() }),
    execute: record("respond", async (input: { ref: string; action: ActionKind; value?: string | null | undefined }) => ({ say: await respond(scope, input.ref, input.action, input.value ?? null) })),
  });

  const handOver = createTool({
    id: "hand_over",
    description: "Give the thing being talked about to the other adult. They get one message about it.",
    inputSchema: z.object({ ref: z.string().nullable(), to: z.string() }),
    execute: record("hand_over", async (input: { ref: string | null; to: string }) => {
      if (input.ref === null) return { say: "Tap the thing you mean first, then tell me who's doing it." };
      const people = await rt.system("hand-over").household.people();
      const to = adultsOf(people).find((p) => p.name.toLowerCase() === input.to.toLowerCase() || p.id === input.to.toLowerCase());
      if (to === undefined || to.id === scope.person) return { say: `I can only hand things to ${adultsOf(people).filter((p) => p.id !== scope.person).map((p) => p.name).join(" or ")}.` };
      const date = today();
      const title = await subjectFor(scope, input.ref, date);
      await api.plans.handOver({ ref: input.ref, title, to: to.id });
      scope.effects.closeRefs.push({ ref: input.ref, status: "dismissed" });
      const from = people.find((p) => p.id === scope.person)?.name ?? "Someone";
      scope.effects.notify.push({
        person: to.id,
        message: `${from} handed this to you: ${title}`,
        urgency: Urgency.urgent,
        actions: [
          { kind: ActionKind.done, label: "Done", ref: input.ref },
          { kind: ActionKind.notToday, label: "Not today", ref: input.ref },
        ],
        key: `handover:${input.ref}:${date}`,
        countsTowardsBudget: true,
      });
      replanToday();
      return { say: `Okay, ${to.name} has it now, with one message about it.` };
    }),
  });

  const moveToTomorrow = createTool({
    id: "move_to_tomorrow",
    description: "Move the thing being talked about to tomorrow (a snooze). Works on whatever was tapped, so 'this' needs no explanation.",
    inputSchema: z.object({ ref: z.string().nullable() }),
    execute: record("move_to_tomorrow", async (input: { ref: string | null }) => {
      if (input.ref === null) return { say: "Tap the thing you mean first." };
      await respond(scope, input.ref, ActionKind.snooze, addLocalDays(today(), 1));
      return { say: `Moved "${await subjectFor(scope, input.ref, today())}" to tomorrow.` };
    }),
  });

  const sitterBooked = createTool({
    id: "sitter_booked",
    description: "A named babysitter is booked for a day (e.g. 'Hannah's doing Thursday').",
    inputSchema: z.object({ sitter: z.string(), when: z.string().describe("The day, as they said it: 'Tuesday', 'tomorrow', or a date like 'Tuesday 3 November'.") }),
    execute: record("sitter_booked", async (input: { sitter: string; when: string }) => {
      const date = dayIn(input.when, today());
      // PRO-2: never guess the day; a booking on the wrong day leaves the real night uncovered.
      if (date === null) return { booked: false, say: `Which day is ${input.sitter} doing? I couldn't tell from "${input.when}".` };
      const booking = await api.household.recordSitterBooking({ sitter: input.sitter, date });
      scope.effects.closeRefs.push({ ref: `sitter:${date}`, status: "done" });
      replanToday();
      return { booked: true, say: `Great, ${booking.sitter} is down for ${longDate(date)}.` };
    }),
  });

  const recordArrival = createTool({
    id: "record_arrival",
    description: "An order confirmation email: record the shop and expected day (and whether someone must be in). Keep nothing else.",
    inputSchema: z.object({ email: z.string().optional(), shop: z.string().optional(), expectedDate: z.string().optional(), window: z.string().nullable().optional(), needsSomeoneIn: z.boolean().optional() }),
    execute: record("record_arrival", async (input: { email?: string | undefined; shop?: string | undefined; expectedDate?: string | undefined; window?: string | null | undefined; needsSomeoneIn?: boolean | undefined }) => {
      const parsed = input.email === undefined ? null : parseOrder(input.email, today());
      const shopName = input.shop ?? parsed?.shop;
      const expectedDate = input.expectedDate ?? parsed?.expectedDate;
      if (shopName === undefined || expectedDate === undefined) return { recorded: false, say: "" };
      const arrival = await api.parcels.record({ shop: shopName, expectedDate, window: input.window ?? parsed?.window ?? null, needsSomeoneIn: input.needsSomeoneIn ?? parsed?.needsSomeoneIn ?? false, person: scope.person, sourceKey: scope.messageId });
      for (const d of [arrival.expectedDate, addLocalDays(arrival.expectedDate, -1)]) if (!scope.effects.replan.includes(d)) scope.effects.replan.push(d);
      return { recorded: true, shop: arrival.shop, expectedDate: arrival.expectedDate, say: `${arrival.shop} is arriving ${longDate(arrival.expectedDate)}.` };
    }),
  });

  const todayTool = createTool({
    id: "today",
    description: "What today looks like: the context line and what's next on the calendar.",
    inputSchema: z.object({}),
    execute: record("today", async () => {
      const date = today();
      const facts = await gatherFacts(rt, date, 1);
      const now = rt.ports.clock.now();
      const next = eventsOn(facts, date).find((e) => new Date(e.start) > now);
      const nextText = next === undefined ? "Nothing else on the calendar today." : `Next: ${next.title} at ${clock(next.start, tz)}.`;
      return { say: `${contextLine(facts, date, now)}. ${nextText}` };
    }),
  });

  return {
    capture,
    shop,
    add_to_list: addToList,
    set_mode: setMode,
    what_now: whatNow,
    respond: respondTool,
    hand_over: handOver,
    move_to_tomorrow: moveToTomorrow,
    sitter_booked: sitterBooked,
    record_arrival: recordArrival,
    today: todayTool,
  };
}

