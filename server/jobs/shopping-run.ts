import { DBOS } from "@dbos-inc/dbos-sdk";
import { ActionKind, ShoppingStatus, Urgency } from "@household/contracts";
import { notify } from "../notify/notify.ts";
import type { HelperResult } from "../ports.ts";
import { localDate } from "../time.ts";
import { jobRuntime } from "./context.ts";
import { planDay } from "./plan-day.ts";

type Stored = { kind: HelperResult["kind"]; product: { sku: string; name: string; price: string } | null; options: { sku: string; name: string; price: string }[]; runId: string; reason: string | null };

/**
 * PLT-10 / AUT-1: a child workflow drives the sealed helper (AUT-2), keeps its log and screenshots
 * in object storage (AUT-6, PLT-7), asks one question when there is no exact match (AUT-3), and
 * reports back to the job that started it.
 */
async function runShoppingImpl(requestId: string, sku: string | null, parentJob: string, person: string | null): Promise<void> {
  const rt = jobRuntime();
  const api = rt.system("shopping");
  const stored = await DBOS.runStep(
    async (): Promise<Stored> => {
      const request = await api.shopping.get({ id: requestId });
      if (request === null) throw new Error(`no shopping request ${requestId}`);
      const result = sku === null ? await rt.ports.shopping.addItem(request.item) : await rt.ports.shopping.addProduct(sku);
      const keys: string[] = [];
      for (const [i, shot] of result.screenshots.entries()) {
        const key = `runs/${requestId}/${String(i).padStart(2, "0")}-${shot.name}.png`;
        await rt.ports.objects.put(key, shot.png, "image/png");
        keys.push(key);
      }
      const at = rt.ports.clock.now().toISOString();
      const runId = await api.shopping.addRun({ requestId, log: result.log.map((line) => ({ at, line })), screenshots: keys });
      if (result.kind === "added") await api.shopping.recordAdd({ requestId, sku: result.product.sku, name: result.product.name });
      await api.shopping.update({
        id: requestId,
        status: result.kind === "added" ? ShoppingStatus.added : result.kind === "needs-choice" ? ShoppingStatus.needsChoice : ShoppingStatus.failed,
        chosen: result.kind === "added" ? result.product : null,
        options: result.kind === "needs-choice" ? result.options : [],
      });
      return { kind: result.kind, product: result.kind === "added" ? result.product : null, options: result.kind === "needs-choice" ? result.options : [], runId, reason: result.kind === "failed" ? result.reason : null };
    },
    { name: "helper" },
  );
  if (stored.kind === "needs-choice" && person !== null) {
    await DBOS.runStep(
      async () => {
        const request = await api.shopping.get({ id: requestId });
        const ref = `shopping:${requestId}`;
        await notify(
          rt,
          {
            person,
            message: `No exact match for "${request?.item ?? "that"}". Which one?`,
            urgency: Urgency.urgent,
            actions: stored.options.map((o) => ({ kind: ActionKind.answer, label: o.name, ref, value: o.sku })),
            key: `${ref}:question`,
            countsTowardsBudget: true,
          },
          parentJob,
        );
      },
      { name: "ask" },
    );
  }
  await DBOS.send(parentJob, { requestId, kind: stored.kind, runId: stored.runId }, "shopping");
  await planDay(localDate(rt.ports.clock.now(), rt.timeZone), `shopping:${requestId}`, parentJob);
}

export const runShopping = DBOS.registerWorkflow(runShoppingImpl, { name: "runShopping" });
