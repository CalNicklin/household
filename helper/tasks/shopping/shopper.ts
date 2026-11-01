import { Limits, type ProductOption } from "@household/contracts";
import type { TaskDeps } from "../../registry.ts";
import { isExactMatch, normaliseRequest } from "./match.ts";
import { GuardedSession, type Screenshot } from "./session.ts";
import { ShoppingStore } from "./store.ts";

export type RunResult =
  | { kind: "added"; product: ProductOption; log: string[]; screenshots: Screenshot[] }
  | { kind: "needs-choice"; options: ProductOption[]; log: string[]; screenshots: Screenshot[] }
  | { kind: "failed"; reason: string; log: string[]; screenshots: Screenshot[] };

export type Basket = { items: { sku: string; name: string; quantity: number }[]; deliveryDate: string | null; changeUrl: string };

/**
 * The shopping helper's only abilities: search, add, read the basket. There is no checkout, no
 * slot change and no removal of anything it did not add (AUT-4) — not as an API, and not in the browser.
 */
export class Shopper {
  readonly #deps: TaskDeps;
  readonly store: ShoppingStore;

  constructor(deps: TaskDeps) {
    this.#deps = deps;
    this.store = new ShoppingStore(deps.dataDir);
  }

  async #run<T>(work: (s: GuardedSession) => Promise<T>): Promise<{ value: T; session: GuardedSession }> {
    const log = this.#deps.newLog();
    const session = await GuardedSession.open(this.#deps, this.store, log);
    try {
      await session.signIn(this.#deps.credentials.username, this.#deps.credentials.password);
      return { value: await work(session), session };
    } finally {
      await session.close();
    }
  }

  async #readResults(s: GuardedSession): Promise<ProductOption[]> {
    return s.page.$$eval("#results .product", (cards) =>
      cards.map((card) => ({
        sku: card.getAttribute("data-sku") ?? "",
        name: card.querySelector(".name")?.textContent?.trim() ?? "",
        price: card.querySelector(".price")?.textContent?.trim() ?? "",
      })),
    );
  }

  async #addSku(s: GuardedSession, sku: string): Promise<ProductOption | null> {
    await s.page.goto(s.url(`/product/${encodeURIComponent(sku)}`));
    const card = s.page.locator(`.product[data-sku="${sku}"]`);
    if ((await card.count()) === 0) {
      s.log.line(`no product page for ${sku}`);
      return null;
    }
    const product: ProductOption = {
      sku,
      name: (await card.locator(".name").textContent())?.trim() ?? sku,
      price: (await card.locator(".price").textContent())?.trim() ?? "",
    };
    await s.capture("product");
    await Promise.all([s.page.waitForURL((u) => u.pathname === "/basket"), card.locator("button.add").click()]);
    this.store.update((st) => {
      if (!st.ownAdded.includes(sku)) st.ownAdded.push(sku);
    });
    s.log.line(`added ${product.name} (${product.price}) to the basket`);
    await s.capture("basket");
    return product;
  }

  /** AUT-1 / AUT-3: add an exact match, or add nothing and offer two or three options. */
  async addItem(item: string): Promise<RunResult> {
    const key = normaliseRequest(item);
    const { value, session } = await this.#run(async (s): Promise<{ kind: "added"; product: ProductOption } | { kind: "needs-choice"; options: ProductOption[] } | { kind: "failed"; reason: string }> => {
      s.log.line(`request: "${item}"`);
      const remembered = this.store.read().aliases[key];
      await s.page.goto(s.url(`/search?q=${encodeURIComponent(item)}`));
      await s.capture("search-results");
      const results = await this.#readResults(s);
      s.log.line(`search "${item}": ${results.length} result${results.length === 1 ? "" : "s"}`);
      if (remembered !== undefined && results.some((r) => r.sku === remembered)) {
        s.log.line(`you chose ${remembered} for "${item}" before`);
        const product = await this.#addSku(s, remembered);
        return product === null ? { kind: "failed", reason: `could not add ${remembered}` } : { kind: "added", product };
      }
      if (results.length === 0) return { kind: "failed", reason: `nothing like "${item}" at the supermarket` };
      const exact = results.filter((r) => isExactMatch(item, r.name));
      const only = exact.length === 1 ? exact[0] : undefined;
      if (only !== undefined) {
        s.log.line(`exact match: ${only.name}`);
        const product = await this.#addSku(s, only.sku);
        return product === null ? { kind: "failed", reason: `could not add ${only.sku}` } : { kind: "added", product };
      }
      const pool = exact.length > 1 ? exact : results;
      // limit: shoppingMaxOptions
      const options = pool.slice(0, Limits.shoppingMaxOptions.value);
      this.store.update((st) => {
        st.pending[key] = options.map((o) => o.sku);
      });
      s.log.line(`no single exact match; added nothing and asking: ${options.map((o) => o.name).join(" / ")}`);
      return { kind: "needs-choice", options };
    });
    return { ...value, log: session.log.lines(), screenshots: session.screenshots };
  }

  /** The answer to a question: add the chosen product, and remember it for next time. */
  async addProduct(sku: string): Promise<RunResult> {
    const { value, session } = await this.#run(async (s) => {
      s.log.line(`adding chosen product ${sku}`);
      const product = await this.#addSku(s, sku);
      if (product !== null) {
        this.store.update((st) => {
          for (const [request, skus] of Object.entries(st.pending)) {
            if (!skus.includes(sku)) continue;
            st.aliases[request] = sku;
            delete st.pending[request];
          }
        });
      }
      return product;
    });
    if (value === null) return { kind: "failed", reason: `no product ${sku}`, log: session.log.lines(), screenshots: session.screenshots };
    return { kind: "added", product: value, log: session.log.lines(), screenshots: session.screenshots };
  }

  async basket(): Promise<Basket> {
    const { value } = await this.#run(async (s) => {
      await s.page.goto(s.url("/basket"));
      const items = await s.page.$$eval(".basket-item", (rows) =>
        rows.map((row) => ({
          sku: row.getAttribute("data-sku") ?? "",
          name: row.querySelector(".name")?.textContent?.trim() ?? "",
          quantity: Number(row.querySelector(".quantity")?.textContent ?? "1"),
        })),
      );
      const date = (await s.page.locator("#delivery-date").textContent())?.trim() ?? "";
      s.log.line(`read basket: ${items.length} lines`);
      return { items, deliveryDate: date === "" ? null : date, changeUrl: s.url("/basket") };
    });
    return value;
  }

  /** For tests: a guarded session the caller drives directly, to prove the guard holds. */
  async openGuarded(): Promise<GuardedSession> {
    const session = await GuardedSession.open(this.#deps, this.store, this.#deps.newLog());
    await session.signIn(this.#deps.credentials.username, this.#deps.credentials.password);
    return session;
  }
}
