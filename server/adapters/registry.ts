import { readdirSync } from "node:fs";
import path from "node:path";
import type { Hono } from "hono";
import type { Runtime } from "../runtime.ts";

export type HttpEnv = { Variables: { person: string } };

/** What an adapter is: a way in (routes that turn requests into the one message shape) and maybe a way out. */
export type Adapter = {
  name: string;
  /** Routes on the public app. An adapter that needs no login must check its own secret (PRV-6). */
  routes?: (app: Hono<HttpEnv>, rt: Runtime) => void;
  /** Routes that sit behind the household login. */
  privateRoutes?: (app: Hono<HttpEnv>, rt: Runtime) => void;
  start?: (rt: Runtime) => Promise<void>;
};

/**
 * CH-11: adapters are discovered, not imported. Delete an adapter's folder and the server still
 * starts, and every test outside that folder still passes.
 */
export async function loadAdapters(dir: string = import.meta.dirname): Promise<Adapter[]> {
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const adapters: Adapter[] = [];
  for (const name of names) {
    const mod: { adapter?: Adapter } = await import(path.join(dir, name, "index.ts"));
    if (mod.adapter !== undefined) adapters.push(mod.adapter);
  }
  return adapters;
}
