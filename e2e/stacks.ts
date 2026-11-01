import path from "node:path";

/**
 * FB-2: the journeys run on several Playwright workers at once, and each worker gets a whole stack of
 * its own — Postgres databases, practice supermarket, sealed helper and server — so no journey ever
 * sees another's household. Stack `i` owns ports 3101+10i to 3103+10i, the databases `e2e<i>_*` (the
 * first keeps `e2e_*`) and `.data/e2e/<i>`.
 */
export const STACKS = 3;
/** e2e/stack.ts answers here once every stack's server is up. */
export const READY_PORT = 3100;

export type Stack = { index: number; server: number; shop: number; helper: number; dbPrefix: string; dataDir: string; creds: string };

const root = path.resolve(import.meta.dirname, "..");

export function stack(index: number): Stack {
  const base = 3101 + 10 * index;
  const dataDir = path.join(root, ".data", "e2e", String(index));
  return { index, server: base, shop: base + 1, helper: base + 2, dbPrefix: index === 0 ? "e2e" : `e2e${index}`, dataDir, creds: path.join(dataDir, "supermarket.json") };
}
