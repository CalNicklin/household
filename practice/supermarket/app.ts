import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { supermarket } from "../data.ts";

type Product = { sku: string; name: string; price: string; aliases: readonly string[] };

export type SupermarketState = {
  basket: Map<string, number>;
  deliveryDate: string;
  orders: { at: string; items: { sku: string; quantity: number }[] }[];
  slotChanges: string[];
  sessions: Set<string>;
};

export type SupermarketOptions = { port?: number; username?: string; password?: string };

const catalogue: readonly Product[] = supermarket.catalogue;
const SESSION = "sm_session";

const nameOf = (sku: string): string => catalogue.find((p) => p.sku === sku)?.name ?? sku;

function field(form: Record<string, unknown>, name: string): string {
  const value = form[name];
  return typeof value === "string" ? value : "";
}

function escape(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
}

/** A supermarket search: anything whose name or known aliases share a word with the query. */
export function searchCatalogue(query: string): Product[] {
  const q = words(query);
  if (q.length === 0) return [];
  return catalogue.filter((p) => {
    const haystack = new Set([...words(p.name), ...p.aliases.flatMap(words)]);
    return q.some((w) => haystack.has(w));
  });
}

function page(title: string, body: string, signedIn: boolean): string {
  const nav = signedIn ? `<nav><a href="/search">Shop</a> · <a href="/basket">Basket</a></nav>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(title)} — Practice Grocer</title>
<style>body{font-family:system-ui,sans-serif;margin:0;background:#f6f7f2;color:#1d2a1d}header{background:#2f5d34;color:#fff;padding:12px 24px;display:flex;gap:24px;align-items:center}header a{color:#fff}main{padding:24px;max-width:900px}
.card{background:#fff;border-radius:10px;padding:14px 16px;margin:8px 0;display:flex;justify-content:space-between;align-items:center}.price{font-weight:700;margin-right:12px}button{padding:8px 14px;border-radius:8px;border:0;background:#2f5d34;color:#fff;font-size:15px}
input{padding:8px;font-size:15px}</style></head>
<body><header><strong>Practice Grocer</strong>${nav}</header><main>${body}</main></body></html>`;
}

function productCard(p: Product): string {
  return `<div class="card product" data-sku="${p.sku}"><div><a class="name" href="/product/${p.sku}">${escape(p.name)}</a></div><div><span class="price">${p.price}</span>
<form method="post" action="/basket/add" style="display:inline"><input type="hidden" name="sku" value="${p.sku}"><button type="submit" class="add">Add</button></form></div></div>`;
}

/** QA-9: a small but realistic online supermarket for the practice household's shopping account. */
export function createSupermarketApp(options: SupermarketOptions = {}): { app: Hono; state: SupermarketState } {
  const username = options.username ?? "practice-shopper";
  const password = options.password ?? process.env["PRACTICE_SUPERMARKET_PASSWORD"] ?? randomBytes(18).toString("base64url");
  const state: SupermarketState = {
    basket: new Map(supermarket.basket.map((b) => [b.sku, b.quantity])),
    deliveryDate: supermarket.deliveryDate,
    orders: [],
    slotChanges: [],
    sessions: new Set(),
  };
  const app = new Hono();
  const signedIn = (cookie: string | undefined): boolean => {
    const token = cookie
      ?.split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${SESSION}=`))
      ?.slice(SESSION.length + 1);
    return token !== undefined && state.sessions.has(token);
  };

  app.get("/practice-api/basket", (c) =>
    c.json({
      items: [...state.basket.entries()].map(([sku, quantity]) => ({ sku, name: nameOf(sku), quantity })),
      deliveryDate: state.deliveryDate,
      orders: state.orders,
      slotChanges: state.slotChanges,
    }),
  );

  app.get("/login", (c) =>
    c.html(
      page(
        "Sign in",
        `<h1>Sign in</h1><form method="post" action="/login"><p><label>Email or username <input name="username" id="username" autocomplete="username"></label></p>
<p><label>Password <input type="password" name="password" id="password" autocomplete="current-password"></label></p><button type="submit" id="sign-in">Sign in</button></form>`,
        false,
      ),
    ),
  );
  app.post("/login", async (c) => {
    const form = await c.req.parseBody();
    if (form["username"] !== username || form["password"] !== password) return c.html(page("Sign in", `<p class="error">That didn't work.</p><a href="/login">Try again</a>`, false), 401);
    const token = randomBytes(16).toString("hex");
    state.sessions.add(token);
    c.header("Set-Cookie", `${SESSION}=${token}; Path=/; HttpOnly; SameSite=Lax`);
    return c.redirect("/search");
  });

  app.use("*", async (c, next) => {
    if (c.req.path === "/login" || c.req.path.startsWith("/practice-api/")) return next();
    if (!signedIn(c.req.header("cookie"))) return c.redirect("/login");
    return next();
  });

  app.get("/", (c) => c.redirect("/search"));
  app.get("/search", (c) => {
    const q = c.req.query("q") ?? "";
    const results = q === "" ? [] : searchCatalogue(q);
    const empty = `<p class="no-results">No results for “${escape(q)}”.</p>`;
    const list = q === "" ? "" : results.length === 0 ? empty : `<div id="results">${results.map(productCard).join("")}</div>`;
    return c.html(page("Search", `<form method="get" action="/search"><input name="q" id="q" value="${escape(q)}" placeholder="Search groceries"> <button type="submit" id="search">Search</button></form>${list}`, true));
  });
  app.get("/product/:sku", (c) => {
    const p = catalogue.find((x) => x.sku === c.req.param("sku"));
    if (p === undefined) return c.notFound();
    return c.html(page(p.name, `<h1>${escape(p.name)}</h1>${productCard(p)}`, true));
  });
  app.post("/basket/add", async (c) => {
    const sku = field(await c.req.parseBody(), "sku");
    if (catalogue.some((p) => p.sku === sku)) state.basket.set(sku, (state.basket.get(sku) ?? 0) + 1);
    return c.redirect("/basket");
  });
  app.post("/basket/remove", async (c) => {
    const sku = field(await c.req.parseBody(), "sku");
    state.basket.delete(sku);
    return c.redirect("/basket");
  });
  app.get("/basket", (c) => {
    const rows = [...state.basket.entries()]
      .map(
        ([sku, quantity]) => `<div class="card basket-item" data-sku="${sku}"><div><span class="name">${escape(nameOf(sku))}</span> × <span class="quantity">${quantity}</span></div>
<form method="post" action="/basket/remove"><input type="hidden" name="sku" value="${sku}"><button type="submit" class="remove">Remove</button></form></div>`,
      )
      .join("");
    return c.html(
      page(
        "Basket",
        `<h1>Your basket</h1><p>Delivery: <span id="delivery-date">${state.deliveryDate}</span> · <a href="/slots" id="change-slot">Change delivery slot</a></p>${rows}
<p><a href="/checkout" id="checkout">Checkout</a></p>`,
        true,
      ),
    );
  });
  app.get("/slots", (c) => c.html(page("Delivery slots", `<form method="post" action="/slots"><input name="date" value="${state.deliveryDate}"><button type="submit" id="book-slot">Book slot</button></form>`, true)));
  app.post("/slots", async (c) => {
    const date = field(await c.req.parseBody(), "date");
    state.deliveryDate = date;
    state.slotChanges.push(date);
    return c.redirect("/basket");
  });
  app.get("/checkout", (c) => c.html(page("Checkout", `<form method="post" action="/checkout"><button type="submit" id="place-order">Place order</button></form>`, true)));
  app.post("/checkout", (c) => {
    state.orders.push({ at: new Date().toISOString(), items: [...state.basket.entries()].map(([sku, quantity]) => ({ sku, quantity })) });
    return c.html(page("Order placed", "<h1>Thank you, your order is placed.</h1>", true));
  });

  return { app, state };
}

export async function startSupermarket(options: SupermarketOptions = {}): Promise<{ url: string; state: SupermarketState; close: () => Promise<void> }> {
  const { app, state } = createSupermarketApp(options);
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: options.port ?? 3002 }, (info) => {
      resolve({
        url: `http://localhost:${info.port}`,
        state,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
