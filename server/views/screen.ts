import { ActionKind, type Block, BlockType, type LocalDate, type ScreenView } from "@household/contracts";
import type { Runtime } from "../runtime.ts";

const CLOSING: ReadonlySet<string> = new Set<string>([ActionKind.done, ActionKind.notToday, ActionKind.snooze, ActionKind.handOver, ActionKind.accept, ActionKind.answer, ActionKind.notHelpful]);

/** HOME-4/5: a tap hides the thing everywhere at once — responses are applied when the screen is read. */
export function applyResponses(blocks: readonly Block[], closed: ReadonlySet<string>): Block[] {
  return blocks
    .filter((b) => !closed.has(b.id) && !("ref" in b && closed.has(b.ref)))
    .map((b) => {
      if (b.type !== BlockType.mode || b.pick === null || !closed.has(b.pick.ref)) return b;
      return { ...b, pick: null };
    });
}

/**
 * The home screen (HOME-7): the server's ordered blocks for today, as last planned, with responses
 * applied. No model call is needed to read it (Platform: "the morning screen never needs the AI").
 */
export async function screenView(rt: Runtime, _person: string, date: LocalDate): Promise<ScreenView> {
  const api = rt.system("views");
  const plan = await api.plans.latest({ date });
  const closed = new Set((await api.plans.responsesOn({ date })).filter((r) => CLOSING.has(r.action)).map((r) => r.ref));
  return {
    date,
    version: plan?.version ?? 0,
    generatedAt: plan?.createdAt ?? rt.ports.clock.now().toISOString(),
    blocks: applyResponses(plan?.blocks ?? [], closed),
  };
}
