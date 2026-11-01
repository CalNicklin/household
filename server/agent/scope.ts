import { ActorKind, type Channel, type LocalDate, type LongStep, type NotifyInput } from "@household/contracts";
import type { Api, Runtime } from "../runtime.ts";

/** Things a job must do after the agent step, durably and in order (PLT-10). */
export type Effects = {
  replan: LocalDate[];
  /** PLT-10: tools' long steps, each run in a child workflow that reports back to this job. */
  long: LongStep[];
  notify: NotifyInput[];
  closeRefs: { ref: string; status: "dismissed" | "done" }[];
  /** PRV-8: the only outside people the app may message are the named sitters. */
  sitterAsk: { sitter: string; date: LocalDate; from: string }[];
  /** Memory to keep in Hindsight, for this person only (PLT-6). */
  remember: string[];
};

export type ToolCall = { tool: string; input: unknown; output: unknown };

/** What a tool can see: the job it runs in, the person it acts for, and the agent-actor API. */
export type JobScope = {
  rt: Runtime;
  jobId: string;
  messageId: string;
  person: string | null;
  channel: Channel;
  api: Api;
  effects: Effects;
  toolCalls: ToolCall[];
};

export function emptyEffects(): Effects {
  return { replan: [], long: [], notify: [], closeRefs: [], sitterAsk: [], remember: [] };
}

export function jobScope(rt: Runtime, jobId: string, messageId: string, person: string | null, channel: Channel): JobScope {
  return {
    rt,
    jobId,
    messageId,
    person,
    channel,
    api: rt.as({ kind: ActorKind.agent, job: jobId, onBehalfOf: person, message: messageId }),
    effects: emptyEffects(),
    toolCalls: [],
  };
}
