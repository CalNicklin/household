import type { BrowserContext, Page, Route } from "playwright";
import type { TaskDeps } from "../../registry.ts";
import type { Logger } from "../../secrets.ts";
import type { ShoppingStore } from "./store.ts";

export type Screenshot = { name: string; png: Uint8Array };

/** Paths the helper may never reach, whatever any instruction says (AUT-4). */
const FORBIDDEN_PATHS = [/^\/checkout\b/, /^\/slots\b/, /^\/order/, /^\/payment/];

/**
 * A browser session with permissions enforced at the network layer (AUT-4): checkout, delivery
 * slots and order placement are aborted before they leave the browser, and a basket removal is
 * only let through for a SKU this helper added itself.
 */
export class GuardedSession {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly log: Logger;
  readonly screenshots: Screenshot[] = [];
  readonly blocked: string[] = [];
  readonly #baseUrl: string;

  private constructor(context: BrowserContext, page: Page, log: Logger, baseUrl: string) {
    this.context = context;
    this.page = page;
    this.log = log;
    this.#baseUrl = baseUrl;
  }

  static async open(deps: TaskDeps, store: ShoppingStore, log: Logger): Promise<GuardedSession> {
    const browser = await deps.browser();
    const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
    const origin = new URL(deps.credentials.url).origin;
    const session = new GuardedSession(context, await context.newPage(), log, deps.credentials.url.replace(/\/$/, ""));
    await context.route("**/*", (route) => session.#guard(route, store, origin));
    return session;
  }

  async #guard(route: Route, store: ShoppingStore, origin: string): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin) {
      if (FORBIDDEN_PATHS.some((p) => p.test(url.pathname))) return this.#block(route, `${request.method()} ${url.pathname} is not allowed`);
      if (request.method() === "POST" && url.pathname === "/basket/remove") {
        const sku = new URLSearchParams(request.postData() ?? "").get("sku") ?? "";
        if (!store.isOwn(sku)) return this.#block(route, `removing ${sku} is not allowed: the helper did not add it`);
      }
    }
    await route.continue();
  }

  async #block(route: Route, reason: string): Promise<void> {
    this.blocked.push(reason);
    this.log.line(`blocked: ${reason}`);
    await route.abort("blockedbyclient");
  }

  url(pathname: string): string {
    return `${this.#baseUrl}${pathname}`;
  }

  async signIn(username: string, password: string): Promise<void> {
    await this.page.goto(this.url("/login"));
    await this.page.fill("#username", username);
    await this.page.fill("#password", password);
    await Promise.all([this.page.waitForURL((u) => !u.pathname.startsWith("/login")), this.page.click("#sign-in")]);
    this.log.line("signed in to the supermarket");
  }

  async capture(name: string): Promise<void> {
    this.screenshots.push({ name, png: new Uint8Array(await this.page.screenshot({ fullPage: true })) });
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}
