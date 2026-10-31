import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { mkdirSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { type Browser, chromium } from "playwright";
import { type HelperTask, loadTasks, type TaskDeps } from "./registry.ts";
import { createRedactor, createRunLog, type Credentials } from "./secrets.ts";

export type HelperOptions = {
  token: string;
  credentials: Credentials;
  dataDir: string;
  tasksDir?: string;
  tasks?: HelperTask[];
};

function bearerMatches(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header?.replace(/^Bearer /, "") ?? "");
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * AUT-2: the sealed helper. Its own process and container, its own supermarket login, and an API
 * that only the household server holds the token for. Each task mounts under /tasks/<name>.
 */
export async function createHelperApp(options: HelperOptions): Promise<{ app: Hono; close: () => Promise<void> }> {
  mkdirSync(options.dataDir, { recursive: true });
  const redact = createRedactor([options.credentials.password, options.credentials.username]);
  let browser: Promise<Browser> | null = null;
  const deps: TaskDeps = {
    credentials: options.credentials,
    dataDir: options.dataDir,
    browser: () => (browser ??= chromium.launch()),
    newLog: () => createRunLog(redact),
    redact,
  };
  const app = new Hono();
  app.get("/healthz", (c) => c.text("ok"));
  app.use("/tasks/*", async (c, next) => {
    if (!bearerMatches(c.req.header("authorization"), options.token)) return c.json({ error: "unauthorised" }, 401);
    await next();
    // Belt and braces: nothing a task returns may carry the login.
    const body = await c.res.clone().text();
    const clean = redact(body);
    if (clean !== body) c.res = new Response(clean, c.res);
  });
  const tasks = options.tasks ?? (await loadTasks(options.tasksDir));
  for (const task of tasks) {
    const sub = new Hono();
    task.routes(sub, deps);
    app.route(`/tasks/${task.name}`, sub);
  }
  app.get("/tasks", (c) => c.json(tasks.map((t) => t.name)));
  return {
    app,
    close: async () => {
      if (browser !== null) await (await browser).close();
    },
  };
}

export async function startHelper(options: HelperOptions & { port?: number }): Promise<{ url: string; close: () => Promise<void> }> {
  const { app, close } = await createHelperApp(options);
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: options.port ?? 3003 }, (info) => {
      resolve({
        url: `http://localhost:${info.port}`,
        close: async () => {
          await close();
          await new Promise<void>((done) => {
            server.close(() => done());
          });
        },
      });
    });
  });
}
