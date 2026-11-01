import { ActorKind, type LiveTopic } from "@household/contracts";
import { initTRPC, TRPCError } from "@trpc/server";

/**
 * Who is asking. PRV-1 is enforced on this, in code: an `agent` actor can add suggestions and
 * record responses, and can create a backlog item only from a person's own message; it can never
 * edit or delete what a person wrote. Only `system` (calendar sync) writes the calendar copy.
 */
export type Actor =
  | { kind: typeof ActorKind.person; person: string }
  | { kind: typeof ActorKind.agent; job: string; onBehalfOf: string | null; message: string }
  | { kind: typeof ActorKind.system; reason: string };

type Ctx = {
  actor: Actor;
  now: Date;
  publish: (topic: LiveTopic) => void;
};

const t = initTRPC.context<Ctx>().create();

export const router = t.router;
export const createCallerFactory = t.createCallerFactory;

/** Reads are open to any actor inside the process; HTTP exposure is gated by login (PRV-6). */
export const readProcedure = t.procedure;

export const personProcedure = t.procedure.use(({ ctx, next }) => {
  if (ctx.actor.kind !== ActorKind.person) throw new TRPCError({ code: "FORBIDDEN", message: "PRV-1: only a person can do this" });
  return next({ ctx: { ...ctx, actor: ctx.actor } });
});

export const systemProcedure = t.procedure.use(({ ctx, next }) => {
  if (ctx.actor.kind !== ActorKind.system) throw new TRPCError({ code: "FORBIDDEN", message: "PRV-1: only the system can do this" });
  return next({ ctx: { ...ctx, actor: ctx.actor } });
});

/** Agent or person: recording responses, suggestions, modes. Never edits of person-written records. */
export const actorProcedure = t.procedure.use(({ ctx, next }) => {
  if (ctx.actor.kind === ActorKind.system) throw new TRPCError({ code: "FORBIDDEN", message: "needs a person or a job acting for one" });
  return next({ ctx: { ...ctx, actor: ctx.actor } });
});

/** The person a request is for: the person themselves, or whoever a job is acting for. */
export function actingPerson(actor: Actor): string | null {
  switch (actor.kind) {
    case ActorKind.person:
      return actor.person;
    case ActorKind.agent:
      return actor.onBehalfOf;
    case ActorKind.system:
      return null;
  }
}

export function forbid(message: string): never {
  throw new TRPCError({ code: "FORBIDDEN", message });
}
