import { type AnswerPick, type ConversationView, ExchangeState, JobStatus, zAnswerPick } from "@household/contracts";
import type { Runtime } from "../runtime.ts";
import { localDate, startOfLocalDay } from "../time.ts";

/** The `what_now` tool's output, when it named one thing (server/agent/tools.ts). */
function pickOf(toolCalls: readonly { tool: string; output: unknown }[]): AnswerPick | null {
  const call = toolCalls.findLast((c) => c.tool === "what_now");
  if (call === undefined) return null;
  const parsed = zAnswerPick.safeParse(call.output);
  return parsed.success ? { title: parsed.data.title, why: parsed.data.why } : null;
}

/**
 * HOU-159: today's conversation between this person and the house, oldest first: each thing they
 * said in the app (taps are not things said) and the house's reply. Only today's, in the house's
 * time zone, so yesterday's is gone. HOU-149: an answer from `what_now` also carries the one thing
 * it named, so the screen shows the thing and its reason rather than prose.
 */
export async function conversationView(rt: Runtime, person: string): Promise<ConversationView> {
  const api = rt.system("views");
  const since = startOfLocalDay(localDate(rt.ports.clock.now(), rt.timeZone), rt.timeZone).toISOString();
  const exchanges = (await api.jobs.exchanges({ person, since })).filter((e) => !e.tap);
  return Promise.all(
    exchanges.map(async (e) => {
      const job = await api.jobs.jobForMessage({ id: e.id });
      const said = e.redacted || e.text.trim() === "" ? null : e.text;
      if (e.reply !== null) {
        return { id: e.id, said, saidAt: e.receivedAt, state: ExchangeState.answered, reply: { ...e.reply, pick: job === null ? null : pickOf(job.toolCalls) } };
      }
      const state = job?.status === JobStatus.failed ? ExchangeState.failed : job?.status === JobStatus.succeeded ? ExchangeState.quiet : ExchangeState.waiting;
      return { id: e.id, said, saidAt: e.receivedAt, state, reply: null };
    }),
  );
}
