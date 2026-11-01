import { type AnswerPick, type ConversationView, zAnswerPick } from "@household/contracts";
import type { Runtime } from "../runtime.ts";

/** The `what_now` tool's output, when it named one thing (server/agent/tools.ts). */
function pickOf(toolCalls: readonly { tool: string; output: unknown }[]): AnswerPick | null {
  const call = toolCalls.findLast((c) => c.tool === "what_now");
  if (call === undefined) return null;
  const parsed = zAnswerPick.safeParse(call.output);
  return parsed.success ? { title: parsed.data.title, why: parsed.data.why } : null;
}

/**
 * The house's replies to this person, newest first. HOU-149: the newest one also carries the one
 * thing a `what_now` answer named, so the screen shows the thing and its reason rather than prose.
 */
export async function conversationView(rt: Runtime, person: string): Promise<ConversationView> {
  const api = rt.system("views");
  const replies = await api.jobs.replies({ person });
  return Promise.all(
    replies.map(async (r, i) => {
      const job = i === 0 ? await api.jobs.jobForMessage({ id: r.inReplyTo }) : null;
      return { id: r.id, text: r.text, createdAt: r.createdAt, pick: job === null ? null : pickOf(job.toolCalls) };
    }),
  );
}
