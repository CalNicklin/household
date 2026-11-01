import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { Hono } from "hono";
import type { Browser } from "playwright";
import type { Credentials, Logger } from "./secrets.ts";

/** What every task gets: its own credentials, a data dir, a browser, and a redacting log. */
export type TaskDeps = {
  credentials: Credentials;
  dataDir: string;
  browser: () => Promise<Browser>;
  newLog: () => Logger;
  redact: (text: string) => string;
};

/**
 * AUT-7: a helper task is a folder under `tasks/` exporting `task`. A second helper (booking the
 * MOT, renewing a prescription) is a new folder; nothing else changes.
 */
export type HelperTask = {
  name: string;
  routes: (app: Hono, deps: TaskDeps) => void;
};

const TASKS_DIR = path.join(import.meta.dirname, "tasks");

export async function loadTasks(dir: string = TASKS_DIR): Promise<HelperTask[]> {
  const tasks: HelperTask[] = [];
  const folders = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const name of folders) {
    const entry = path.join(dir, name, "index.ts");
    if (!existsSync(entry)) continue;
    const mod: { task?: HelperTask } = await import(entry);
    if (mod.task !== undefined) tasks.push(mod.task);
  }
  return tasks;
}
