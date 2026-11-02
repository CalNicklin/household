import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { isConfirmationLink } from "./verify.ts";

/**
 * HOU-150: Gmail sends a code to a new forwarding address before it will forward to it. The receiver
 * keeps only the latest code, its confirmation link (HOU-169) and when it came (in memory-backed storage
 * inside its own container), and `household-email last-confirmation` prints them if they came within the
 * hour. Both are one-time and expire. Nothing else of that email is kept.
 */
const FILE = "forwarding-confirmation.json";
/** Cal confirms forwarding within minutes of asking for it; an older code is someone else's or stale. */
const FRESH_MS = 60 * 60 * 1000;
const zSaved = z.object({
  code: z.string().regex(/^\d{6,12}$/).nullable(),
  // The pattern verify.ts reads it with: URL characters only, so printing it can't write control sequences.
  link: z.string().refine(isConfirmationLink).nullable(),
  at: z.iso.datetime(),
});
export type SavedConfirmation = { code: string | null; link: string | null };

export async function saveConfirmation(dir: string, confirmation: SavedConfirmation, at: Date): Promise<void> {
  const file = path.join(dir, FILE);
  await writeFile(`${file}.new`, JSON.stringify(zSaved.parse({ code: confirmation.code, link: confirmation.link, at: at.toISOString() })), { mode: 0o600 });
  await rename(`${file}.new`, file);
}

export async function lastConfirmation(dir: string, now: Date): Promise<SavedConfirmation | null> {
  let saved: z.infer<typeof zSaved>;
  try {
    saved = zSaved.parse(JSON.parse(await readFile(path.join(dir, FILE), "utf8")));
  } catch {
    return null;
  }
  const age = now.getTime() - Date.parse(saved.at);
  return age >= 0 && age <= FRESH_MS ? { code: saved.code, link: saved.link } : null;
}
