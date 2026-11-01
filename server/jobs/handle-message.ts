import { DBOS } from "@dbos-inc/dbos-sdk";
import { type ActionKind, AttachmentKind, Channel, JobStatus, type TimerKind } from "@household/contracts";
import { type AgentResult, HouseAgent } from "../agent/agent.ts";
import { type Effects, emptyEffects, jobScope, type ToolCall } from "../agent/scope.ts";
import { subjectFor } from "../agent/respond.ts";
import { reply } from "../notify/notify.ts";
import { localDate, longDate } from "../time.ts";
import { jobRuntime } from "./context.ts";
import { applyEffects } from "./effects.ts";
import { runTimer } from "./timers.ts";

type Meta = {
  channel: Channel;
  person: string | null;
  redact: boolean;
  tap: { ref: string; action: ActionKind; value: string | null } | null;
  timer: { timer: TimerKind; scheduledFor: string } | null;
  calendarChange: boolean;
};

type AgentStep = AgentResult & { effects: Effects; toolCalls: ToolCall[] };

/** Load what routing needs, but not the words: email text must not land in the workflow's checkpoints (PRV-3). */
async function loadMeta(messageId: string): Promise<Meta> {
  const rt = jobRuntime();
  const m = await rt.system("job").jobs.message({ id: messageId });
  if (m === null) throw new Error(`no message ${messageId}`);
  const settings = await rt.system("job").household.settings();
  const ref = m.attachments.find((a) => a.kind === AttachmentKind.ref);
  const timer = m.attachments.find((a) => a.kind === AttachmentKind.timer);
  return {
    channel: m.channel,
    person: m.person,
    redact: m.channel === Channel.email || !settings.retainMessages,
    tap: ref?.kind === AttachmentKind.ref && ref.action !== undefined ? { ref: ref.ref, action: ref.action, value: ref.value ?? null } : null,
    timer: timer?.kind === AttachmentKind.timer ? { timer: timer.timer, scheduledFor: timer.scheduledFor } : null,
    calendarChange: m.attachments.some((a) => a.kind === AttachmentKind.calendarChange),
  };
}

async function agentStep(jobId: string, messageId: string, meta: Meta): Promise<AgentStep> {
  const rt = jobRuntime();
  const scope = jobScope(rt, jobId, messageId, meta.person, meta.channel);
  const agent = new HouseAgent(scope);
  let result: AgentResult;
  if (meta.tap !== null) {
    result = await agent.tap(meta.tap.ref, meta.tap.action, meta.tap.value);
  } else {
    const m = await rt.system("job").jobs.message({ id: messageId });
    const text = m?.text ?? "";
    const audio = m?.attachments.find((a) => a.kind === AttachmentKind.audio);
    const words = text !== "" ? text : audio?.kind === AttachmentKind.audio ? audio.transcript : "";
    const refAttachment = m?.attachments.find((a) => a.kind === AttachmentKind.ref);
    const now = rt.ports.clock.now();
    const about = refAttachment?.kind === AttachmentKind.ref ? { ref: refAttachment.ref, title: await subjectFor(scope, refAttachment.ref, localDate(now, rt.timeZone)) } : null;
    const people = await rt.system("job").household.people();
    const personName = people.find((p) => p.id === meta.person)?.name ?? "someone";
    // PLT-6: the coordinator pulls only this person's memories of this house into the prompt.
    const memory = meta.person === null || meta.channel === Channel.email ? [] : await rt.ports.memory.recall({ household: rt.env.HOUSEHOLD_ID, person: meta.person }, words);
    result = await agent.respond({ text: words, personName, channel: meta.channel, about, memory, when: `${longDate(localDate(now, rt.timeZone))} ${now.toISOString().slice(11, 16)}Z` });
    if (meta.person !== null && meta.channel !== Channel.email && words !== "") scope.effects.remember.push(`Said: "${words}"`);
  }
  // PRV-3: an email's words never leave the step; only the shop and date recorded by the tool remain.
  const toolCalls = meta.channel === Channel.email ? scope.toolCalls.map((c) => ({ tool: c.tool, input: "[email]", output: c.output })) : scope.toolCalls;
  return { ...result, effects: scope.effects, toolCalls };
}

async function handleMessageImpl(messageId: string): Promise<void> {
  const rt = jobRuntime();
  const jobId = DBOS.workflowID ?? `job-${messageId}`;
  const started = Date.now();
  await DBOS.runStep(async () => rt.system("job").jobs.startJob({ id: jobId, messageId, provider: rt.env.MODEL_PROVIDER, model: rt.env.MODEL_ID }), { name: "start" });
  const meta = await DBOS.runStep(() => loadMeta(messageId), { name: "load" });
  let usage = { inputTokens: 0, outputTokens: 0, costMicros: 0 };
  let toolCalls: ToolCall[] = [];
  let intent = "";
  let error: string | null = null;
  try {
    if (meta.timer !== null) {
      intent = `timer:${meta.timer.timer}`;
      usage = await runTimer(jobId, meta.timer.timer, meta.timer.scheduledFor);
    } else if (meta.calendarChange) {
      intent = "calendar-change";
      const changed = await DBOS.runStep(
        async () => {
          const api = rt.system("calendar-sync");
          const token = await api.calendar.syncToken();
          const changes = await rt.ports.calendar.changes(token);
          const applied = await api.calendar.applySync({ upserts: changes.upserts, deletedExternalIds: changes.deletedExternalIds, syncToken: changes.nextSyncToken });
          return { ...applied, firstSync: token === null };
        },
        { name: "calendar-sync" },
      );
      // CH-6: only the days the change touched are re-planned.
      const effects = emptyEffects();
      const today = localDate(rt.ports.clock.now(), rt.timeZone);
      effects.replan = changed.changedDates.filter((d) => d >= today);
      // HOU-149: the first sync connects the calendar, which today's "Getting started" cards talk about.
      if (changed.firstSync && !effects.replan.includes(today)) effects.replan.unshift(today);
      usage = await applyEffects(jobId, effects, null);
      toolCalls = [{ tool: "calendar-sync", input: {}, output: changed }];
    } else {
      const step = await DBOS.runStep(() => agentStep(jobId, messageId, meta), { name: "agent" });
      intent = step.intent;
      toolCalls = step.toolCalls;
      await DBOS.runStep(() => reply(rt, messageId, meta.person, meta.channel, step.reply), { name: "reply" });
      const more = await applyEffects(jobId, step.effects, meta.person);
      usage = { inputTokens: step.inputTokens + more.inputTokens, outputTokens: step.outputTokens + more.outputTokens, costMicros: step.costMicros + more.costMicros };
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  if (meta.redact) await DBOS.runStep(async () => rt.system("PRV-3/PRV-5").jobs.redactMessage({ id: messageId }), { name: "redact" });
  await DBOS.runStep(
    async () =>
      rt.system("job").jobs.finishJob({ id: jobId, intent, status: error === null ? JobStatus.succeeded : JobStatus.failed, ...usage, durationMs: Date.now() - started, toolCalls, error }),
    { name: "finish" },
  );
  if (error !== null) throw new Error(error);
}

const handleMessage = DBOS.registerWorkflow(handleMessageImpl, { name: "handleMessage" });

/** The coordinator starts a job and returns; the workflow ID makes a duplicate start a no-op (CH-4). */
export async function startMessageJob(jobId: string, messageId: string): Promise<void> {
  await DBOS.startWorkflow(handleMessage, { workflowID: jobId })(messageId);
}
