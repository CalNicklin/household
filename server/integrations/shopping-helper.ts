import { zProductOption } from "@household/contracts";
import { z } from "zod";
import type { HelperResult, ShoppingHelper } from "../ports.ts";

const zShot = z.object({ name: z.string(), png: z.string() });
const zWireResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("added"), product: zProductOption, log: z.array(z.string()), screenshots: z.array(zShot) }),
  z.object({ kind: z.literal("needs-choice"), options: z.array(zProductOption), log: z.array(z.string()), screenshots: z.array(zShot) }),
  z.object({ kind: z.literal("failed"), reason: z.string(), log: z.array(z.string()), screenshots: z.array(zShot) }),
]);
const zBasket = z.object({
  items: z.array(z.object({ sku: z.string(), name: z.string(), quantity: z.number().int() })),
  deliveryDate: z.iso.date().nullable(),
  changeUrl: z.string(),
});

const decodeShots = (shots: z.infer<typeof zShot>[]) => shots.map((s) => ({ name: s.name, png: new Uint8Array(Buffer.from(s.png, "base64")) }));

/**
 * The household server's side of the sealed shopping helper (AUT-2). It holds a token for the
 * helper's API and nothing else: never the supermarket login, which only the helper can read.
 */
export class HttpShoppingHelper implements ShoppingHelper {
  readonly #url: string;
  readonly #token: string;

  constructor(url: string, token: string) {
    this.#url = url.replace(/\/$/, "");
    this.#token = token;
  }

  async #call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const init: RequestInit = { method, headers: { authorization: `Bearer ${this.#token}`, "content-type": "application/json" } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(`${this.#url}/tasks/shopping${path}`, init);
    if (!res.ok) throw new Error(`shopping helper ${path} answered ${res.status}`);
    return res.json();
  }

  async #result(path: string, body: unknown): Promise<HelperResult> {
    const wire = zWireResult.parse(await this.#call("POST", path, body));
    const screenshots = decodeShots(wire.screenshots);
    switch (wire.kind) {
      case "added":
        return { kind: "added", product: wire.product, log: wire.log, screenshots };
      case "needs-choice":
        return { kind: "needs-choice", options: wire.options, log: wire.log, screenshots };
      case "failed":
        return { kind: "failed", reason: wire.reason, log: wire.log, screenshots };
    }
  }

  addItem(item: string): Promise<HelperResult> {
    return this.#result("/add-item", { item });
  }

  addProduct(sku: string): Promise<HelperResult> {
    return this.#result("/add-product", { sku });
  }

  async basket() {
    return zBasket.parse(await this.#call("GET", "/basket"));
  }
}

const NO_HELPER = "the shopping helper is not connected yet, so nothing was added to the basket";

/**
 * The real house before its helper is running (it needs a home connection: the supermarket blocks
 * data-centre addresses). Every request fails with that reason, so it shows as not added rather than
 * pretending; the basket is empty with no delivery, so no basket summary goes out.
 */
export class NoShoppingHelper implements ShoppingHelper {
  async addItem(item: string): Promise<HelperResult> {
    return { kind: "failed", reason: NO_HELPER, log: [`"${item}": ${NO_HELPER}`], screenshots: [] };
  }

  async addProduct(sku: string): Promise<HelperResult> {
    return { kind: "failed", reason: NO_HELPER, log: [`${sku}: ${NO_HELPER}`], screenshots: [] };
  }

  async basket() {
    return { items: [], deliveryDate: null, changeUrl: "" };
  }
}
