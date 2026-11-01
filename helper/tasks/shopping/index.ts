import { z } from "zod";
import type { HelperTask } from "../../registry.ts";
import { type RunResult, Shopper } from "./shopper.ts";

const zAddItem = z.object({ item: z.string().min(1) });
const zAddProduct = z.object({ sku: z.string().min(1) });

/** Over HTTP, screenshots travel as base64 PNG (AUT-6). */
function wire(result: RunResult) {
  return { ...result, screenshots: result.screenshots.map((s) => ({ name: s.name, png: Buffer.from(s.png).toString("base64") })) };
}

export const task: HelperTask = {
  name: "shopping",
  routes: (app, deps) => {
    const shopper = new Shopper(deps);
    app.post("/add-item", async (c) => c.json(wire(await shopper.addItem(zAddItem.parse(await c.req.json()).item))));
    app.post("/add-product", async (c) => c.json(wire(await shopper.addProduct(zAddProduct.parse(await c.req.json()).sku))));
    app.get("/basket", async (c) => c.json(await shopper.basket()));
  },
};
