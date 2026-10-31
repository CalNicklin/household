import {
  ActorKind,
  zBacklogScreen,
  zBacklogSetTagsInput,
  zConversationView,
  zEditRhythmInput,
  zForgetSentenceInput,
  zHealthEntryInput,
  zHouseholdSettingsPatch,
  zIdInput,
  zMe,
  zPersonSettingsPatch,
  zRunLogView,
  zRunView,
  zScreenInput,
  zScreenView,
  zSettingsView,
  zShopView,
  zSpendView,
  zTraceView,
  zWeekView,
  zWellbeingIdeaInput,
} from "@household/contracts";
import { TRPCError } from "@trpc/server";
import type { Runtime } from "../runtime.ts";
import { localDate } from "../time.ts";
import { personProcedure, router } from "../trpc.ts";
import { backlogScreen } from "./backlog.ts";
import { learnedSentences } from "./learned.ts";
import { runView, traceView } from "./runs.ts";
import { screenView } from "./screen.ts";
import { weekView } from "./week.ts";

/**
 * The query layer the app reads and the few direct edits a person makes to their own things
 * (PLT-11). Everything said to the house goes through POST /api/messages instead.
 */
export function viewsRouter(rt: Runtime) {
  const me = (person: string) => rt.as({ kind: ActorKind.person, person });
  return router({
    me: personProcedure.output(zMe).query(async ({ ctx }) => {
      const people = await rt.system("views").household.people();
      const settings = await rt.system("views").household.settings();
      const person = people.find((p) => p.id === ctx.actor.person);
      if (person === undefined) throw new TRPCError({ code: "NOT_FOUND" });
      return { person: person.id, name: person.name, healthOwner: settings.healthOwner === person.id };
    }),
    screen: personProcedure.input(zScreenInput).output(zScreenView).query(async ({ ctx, input }) => screenView(rt, ctx.actor.person, input.date ?? localDate(rt.ports.clock.now(), rt.timeZone))),
    week: personProcedure.output(zWeekView).query(async ({ ctx }) => weekView(rt, ctx.actor.person)),
    backlog: personProcedure.output(zBacklogScreen).query(async () => backlogScreen(rt)),
    shop: personProcedure.output(zShopView).query(async () => {
      const basket = await rt.ports.shopping.basket();
      return { basket: basket.items, deliveryDate: basket.deliveryDate, changeUrl: basket.changeUrl, requests: await rt.system("views").shopping.recent(), lists: await rt.ports.lists.lists() };
    }),
    settings: personProcedure.output(zSettingsView).query(async ({ ctx }) => {
      const api = rt.system("views");
      const today = localDate(rt.ports.clock.now(), rt.timeZone);
      const mine = await api.household.personSettings({ person: ctx.actor.person });
      const from = new Date(rt.ports.clock.now().getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
      return {
        me: mine,
        household: await api.household.settings(),
        learned: await learnedSentences(rt),
        questions: await api.learning.questions(),
        wellbeing: { enabled: mine.wellbeingEnabled, recent: mine.wellbeingEnabled ? await api.wellbeing.scores({ person: ctx.actor.person, from, to: today }) : [] },
        ideas: await api.household.wellbeingIdeas(),
        rules: await api.household.rules(),
      };
    }),
    conversation: personProcedure.output(zConversationView).query(async ({ ctx }) =>
      (await rt.system("views").jobs.replies({ person: ctx.actor.person })).map((r) => ({ id: r.id, text: r.text, createdAt: r.createdAt })),
    ),
    run: personProcedure.input(zIdInput).output(zRunView.nullable()).query(async ({ input }) => runView(rt, input.id)),
    trace: personProcedure.input(zIdInput).output(zTraceView.nullable()).query(async ({ input }) => traceView(rt, input.id)),
    runLog: personProcedure.output(zRunLogView).query(async () => ({ jobs: await rt.system("views").jobs.recentJobs(), timers: await rt.system("views").jobs.timerRuns() })),
    spend: personProcedure.output(zSpendView).query(async () => ({ months: await rt.system("views").jobs.spendByMonth() })),

    setTags: personProcedure.input(zBacklogSetTagsInput).mutation(async ({ ctx, input }) => me(ctx.actor.person).backlog.setTags(input)),
    bringBack: personProcedure.input(zIdInput).mutation(async ({ ctx, input }) => me(ctx.actor.person).backlog.bringBack(input)),
    removeBacklog: personProcedure.input(zIdInput).mutation(async ({ ctx, input }) => me(ctx.actor.person).backlog.remove(input)),
    updateMySettings: personProcedure.input(zPersonSettingsPatch).mutation(async ({ ctx, input }) => me(ctx.actor.person).household.updateMySettings(input)),
    updateHousehold: personProcedure.input(zHouseholdSettingsPatch).mutation(async ({ ctx, input }) => {
      const result = await me(ctx.actor.person).household.updateSettings(input);
      if (input.retainMessages === false) await rt.system("PRV-5 retention off").jobs.redactAll();
      return result;
    }),
    editRhythm: personProcedure.input(zEditRhythmInput).mutation(async ({ ctx, input }) => me(ctx.actor.person).learning.editRhythm(input)),
    forgetSentence: personProcedure.input(zForgetSentenceInput).mutation(async ({ ctx, input }) => {
      if (input.kind === "rhythm") await me(ctx.actor.person).learning.forgetRhythm({ id: input.id });
      else await me(ctx.actor.person).learning.forgetPreference({ id: input.id });
    }),
    addWellbeingIdea: personProcedure.input(zWellbeingIdeaInput).mutation(async ({ ctx, input }) => me(ctx.actor.person).household.addWellbeingIdea(input)),
    removeWellbeingIdea: personProcedure.input(zIdInput).mutation(async ({ ctx, input }) => me(ctx.actor.person).household.removeWellbeingIdea(input)),
    addHealthEntry: personProcedure.input(zHealthEntryInput).mutation(async ({ ctx, input }) => me(ctx.actor.person).health.add(input)),
  });
}
export type ViewsRouter = ReturnType<typeof viewsRouter>;
