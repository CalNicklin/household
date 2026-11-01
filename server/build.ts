import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** What makes this build behave as it does: the server, the contracts, the lockfile, and the built web app. */
const SOURCES = ["server", "contracts/src", "practice", "pnpm-lock.yaml"];

function files(entry: string, out: string[]): void {
  let names: string[];
  try {
    names = readdirSync(entry);
  } catch {
    out.push(entry);
    return;
  }
  for (const name of names.toSorted()) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    files(path.join(entry, name), out);
  }
}

let cached: string | null = null;

/**
 * HOU-154: one short id per build, the same on every process that runs the same code. A deploy changes
 * it, so the service worker (served with it inside) is new and the open page reloads, and a plan made
 * by an older build is redone once. Reading the files themselves needs nothing from the build pipeline.
 */
export function buildId(webDist: string): string {
  if (cached !== null) return cached;
  const hash = createHash("sha256");
  const all: string[] = [];
  for (const source of [...SOURCES, webDist]) files(source, all);
  for (const file of all) {
    try {
      const body = readFileSync(file);
      hash.update(file).update("\0").update(body).update("\0");
    } catch {
      // A file that went away mid-walk (a web build in progress) is left out.
    }
  }
  cached = hash.digest("hex").slice(0, 16);
  return cached;
}
