import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** What makes this build behave as it does: the server, the contracts, the lockfile, and the built web app (not its tests). */
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
    if (name === "node_modules" || name.startsWith(".") || name === "testing" || /\.test\.tsx?$/.test(name)) continue;
    files(path.join(entry, name), out);
  }
}

const cached = new Map<string, string>();

function hashOf(key: string, entries: string[]): string {
  const known = cached.get(key);
  if (known !== undefined) return known;
  const hash = createHash("sha256");
  const all: string[] = [];
  for (const entry of entries) files(entry, all);
  for (const file of all) {
    try {
      const body = readFileSync(file);
      hash.update(file).update("\0").update(body).update("\0");
    } catch {
      // A file that went away mid-walk (a web build in progress) is left out.
    }
  }
  const id = hash.digest("hex").slice(0, 16);
  cached.set(key, id);
  return id;
}

/**
 * HOU-154: one short id per build, the same on every process that runs the same code. A deploy changes
 * it, so the service worker (served with it inside) is new and the open page reloads. Reading the files
 * themselves needs nothing from the build pipeline.
 */
export function buildId(webDist: string): string {
  return hashOf(`web:${webDist}`, [...SOURCES, webDist]);
}

/**
 * HOU-154: the same, without the web app: what makes a plan. A plan made by another planner build is
 * redone once; a deploy that only changes the screens (styling, wording on the page) leaves it be.
 */
export function plannerBuildId(): string {
  return hashOf("planner", SOURCES);
}
