import { ActorKind, TimerKind, zLoginInput } from "@household/contracts";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { type Adapter, type HttpEnv } from "../adapters/registry.ts";
import { buildId } from "../build.ts";
import { acceptTimer } from "../coordinator/accept.ts";
import type { Runtime } from "../runtime.ts";
import { localDate } from "../time.ts";
import { viewsRouter } from "../views/router.ts";
import { clearCookie, personFromCookie, sessionCookie } from "./session.ts";

const startOfHour = (d: Date): Date => new Date(Math.floor(d.getTime() / 3_600_000) * 3_600_000);

const PUBLIC_FILES = /^\/(assets\/|manifest\.webmanifest|sw\.js|icon|favicon|robots\.txt)/;

/**
 * PRV-6: nothing is reachable without a login. Public routes are the login itself, the static
 * shell's assets, and adapter webhooks that check their own shared secret.
 */
export function createApp(rt: Runtime, adapters: Adapter[], extra?: (app: Hono<HttpEnv>) => void): Hono<HttpEnv> {
  const app = new Hono<HttpEnv>();
  const secure = rt.env.PUBLIC_URL.startsWith("https://");
  // HOU-149: a screen asked for with no plan for today starts one, through the coordinator, at most once an hour.
  // HOU-154: a plan made by an older build is redone once for this build and day.
  const views = viewsRouter(rt, {
    planToday: (build) => {
      const now = rt.ports.clock.now();
      if (build === null) return acceptTimer(rt, TimerKind.catchUpPlan, startOfHour(now));
      return acceptTimer(rt, TimerKind.catchUpPlan, now, `timer:${TimerKind.catchUpPlan}:${localDate(now, rt.timeZone)}:build:${build}`);
    },
  });

  app.get("/healthz", (c) => c.text("ok"));

  app.post("/api/login", async (c) => {
    const input = zLoginInput.parse(await c.req.json());
    const person = await rt.system("login").household.login(input);
    if (person === null) return c.json({ ok: false }, 401);
    c.header("Set-Cookie", sessionCookie(person, rt.env.SESSION_SECRET, rt.ports.clock.now(), secure));
    return c.json({ ok: true, person });
  });
  app.post("/api/logout", (c) => {
    c.header("Set-Cookie", clearCookie());
    return c.json({ ok: true });
  });

  for (const a of adapters) a.routes?.(app, rt);

  app.use("*", async (c, next) => {
    const p = c.req.path;
    if (p === "/login" || PUBLIC_FILES.test(p)) return next();
    const person = personFromCookie(c.req.header("cookie"), rt.env.SESSION_SECRET, rt.ports.clock.now());
    if (person === null) {
      if (p.startsWith("/api/") || p.startsWith("/mcp")) return c.json({ error: "login required" }, 401);
      return c.redirect(`/login?next=${encodeURIComponent(p)}`);
    }
    c.set("person", person);
    return next();
  });

  // HOU-166: a navigation a logged-in screen makes to get a waiting service worker to take over (nudge
  // in web/src/data/sw.ts). It does nothing and has nothing to show; the navigation is the point.
  app.get("/api/takeover", (c) => c.body(null, 204));

  app.all("/api/trpc/*", (c) =>
    fetchRequestHandler({
      endpoint: "/api/trpc",
      req: c.req.raw,
      router: views,
      createContext: () => ({ actor: { kind: ActorKind.person, person: c.get("person") }, now: rt.ports.clock.now(), publish: (t) => rt.bus.publish(t) }),
    }),
  );

  /** PLT-11 / MOM-3 / CH-10: the app listens for changes and refetches; it never polls the agent. */
  app.get("/api/live", (c) =>
    streamSSE(c, async (stream) => {
      const queue: string[] = [];
      let wake: (() => void) | null = null;
      const unsubscribe = rt.bus.subscribe((e) => {
        queue.push(e.topic);
        wake?.();
      });
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });
      await stream.writeSSE({ event: "hello", data: "{}" });
      while (!stream.aborted) {
        const topic = queue.shift();
        if (topic !== undefined) {
          await stream.writeSSE({ event: "change", data: JSON.stringify({ topic }) });
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, 25_000);
        });
        wake = null;
        if (queue.length === 0) await stream.writeSSE({ event: "ping", data: "{}" });
      }
    }),
  );

  /** PLT-7: screenshots and documents, decrypted on the way out, only for a logged-in person. */
  app.get("/api/objects/*", async (c) => {
    const key = decodeURIComponent(c.req.path.slice("/api/objects/".length));
    const object = await rt.ports.objects.get(key);
    if (object === null) return c.notFound();
    return new Response(Buffer.from(object.body), { headers: { "content-type": object.contentType, "cache-control": "private, max-age=3600" } });
  });

  for (const a of adapters) a.privateRoutes?.(app, rt);
  extra?.(app);

  const dist = path.resolve(rt.env.WEB_DIST);
  const build = buildId(rt.env.WEB_DIST);
  /**
   * HOU-154: the service worker carries this build's id, so every deploy is a new worker: the browser
   * installs it, it takes over, and the open page reloads once (web/src/data/sw.ts). Never cached.
   */
  app.get("/sw.js", (c) => {
    const file = path.join(dist, "sw.js");
    if (!existsSync(file)) return c.notFound();
    return new Response(readFileSync(file, "utf8").replaceAll("__BUILD__", build), { headers: { "content-type": "text/javascript", "cache-control": "no-cache", "x-household-build": build } });
  });
  app.get("*", (c) => {
    const file = path.join(dist, c.req.path);
    if (file.startsWith(dist) && c.req.path !== "/" && existsSync(file) && !file.endsWith("/")) {
      const type = contentType(file);
      return new Response(readFileSync(file), { headers: { "content-type": type } });
    }
    // HOU-154: a missing hashed asset (an older build's chunk) is not found, never the page, which a
    // service worker would otherwise keep under the asset's name.
    if (c.req.path.startsWith("/assets/")) return c.notFound();
    const shell = path.join(dist, "_shell.html");
    const index = existsSync(shell) ? shell : path.join(dist, "index.html");
    if (!existsSync(index)) return c.text("web app not built: run pnpm --dir web build", 503);
    // HOU-154: the build that served this page, so a person (or a test) can tell which one is running.
    return c.html(readFileSync(index, "utf8").replace("</head>", `<meta name="household-build" content="${build}"></head>`), 200, { "cache-control": "no-cache" });
  });

  return app;
}

function contentType(file: string): string {
  const ext = path.extname(file);
  const types: Record<string, string> = {
    ".js": "text/javascript",
    ".css": "text/css",
    ".html": "text/html",
    ".json": "application/json",
    ".webmanifest": "application/manifest+json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
  };
  return types[ext] ?? "application/octet-stream";
}
