import { ActionKind, type AnswerPick, type ConversationView, ExchangeState, JobStatus, zAnswerPick } from "@household/contracts";
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
 * it named, so the screen shows the thing and its reason rather than prose. HOU-173: an accept tap
 * is an exception, so its answer ("Pencilled in for Wednesday morning") shows as the confirmation; so
 * is a reminder's Change time (HOU-174).
 */
export async function conversationView(rt: Runtime, person: string): Promise<ConversationView> {
  const api = rt.system("views");
  const since = startOfLocalDay(localDate(rt.ports.clock.now(), rt.timeZone), rt.timeZone).toISOString();
  // HOU-173: an accept's answer is news ("Pencilled in for Wednesday morning"), so it shows. HOU-174: so
  // is a reminder's Change time ("Moved: …", or that the time has already gone).
  const exchanges = (await api.jobs.exchanges({ person, since })).filter((e) => !e.tap || e.action === ActionKind.accept || e.action === ActionKind.retime);
  return exchanges.map((e) => {
    const said = e.redacted || e.text.trim() === "" ? null : e.text;
    if (e.reply !== null) return { id: e.id, said, saidAt: e.receivedAt, state: ExchangeState.answered, reply: { ...e.reply, pick: e.job === null ? null : pickOf(e.job.toolCalls) } };
    return { id: e.id, said, saidAt: e.receivedAt, state: stateWithoutReply(e.job?.status ?? null), reply: null };
  });
}

/** An exchange with no reply yet: still going, finished with nothing to say, or failed. */
function stateWithoutReply(status: JobStatus | null): ExchangeState {
  if (status === JobStatus.failed) return ExchangeState.failed;
  if (status === JobStatus.succeeded) return ExchangeState.quiet;
  return ExchangeState.waiting;
}
