import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const zState = z.object({
  /** AUT-4: every SKU this helper itself put in the basket; it may only ever remove these. */
  ownAdded: z.array(z.string()),
  /** AUT-3: requests the household answered before ("oat milk" → the Barista one). */
  aliases: z.record(z.string(), z.string()),
  /** Questions asked and not yet answered: request → the SKUs offered. */
  pending: z.record(z.string(), z.array(z.string())),
});
export type ShoppingState = z.infer<typeof zState>;

export class ShoppingStore {
  readonly #file: string;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.#file = path.join(dataDir, "shopping.json");
  }
  read(): ShoppingState {
    if (!existsSync(this.#file)) return { ownAdded: [], aliases: {}, pending: {} };
    return zState.parse(JSON.parse(readFileSync(this.#file, "utf8")));
  }
  update(change: (state: ShoppingState) => void): ShoppingState {
    const state = this.read();
    change(state);
    writeFileSync(this.#file, JSON.stringify(state, null, 1), { mode: 0o600 });
    return state;
  }
  isOwn(sku: string): boolean {
    return this.read().ownAdded.includes(sku);
  }
}
