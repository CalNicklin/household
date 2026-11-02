import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/**
 * HOU-150: Gmail sends a code to a new forwarding address before it will forward to it. The receiver
 * keeps only the latest code and when it came (in memory-backed storage inside its own container), and
 * `household-email last-confirmation` prints it if it came within the hour. Nothing else of that email
 * is kept.
 */
const FILE = "forwarding-confirmation.json";
/** Cal confirms forwarding within minutes of asking for it; an older code is someone else's or stale. */
const FRESH_MS = 60 * 60 * 1000;
const zSaved = z.object({ code: z.string().regex(/^\d{6,12}$/), at: z.iso.datetime() });

export async function saveConfirmation(dir: string, code: string, at: Date): Promise<void> {
  const file = path.join(dir, FILE);
  await writeFile(`${file}.new`, JSON.stringify(zSaved.parse({ code, at: at.toISOString() })), { mode: 0o600 });
  await rename(`${file}.new`, file);
}

export async function lastConfirmation(dir: string, now: Date): Promise<string | null> {
  let saved: z.infer<typeof zSaved>;
  try {
    saved = zSaved.parse(JSON.parse(await readFile(path.join(dir, FILE), "utf8")));
  } catch {
    return null;
  }
  const age = now.getTime() - Date.parse(saved.at);
  return age >= 0 && age <= FRESH_MS ? saved.code : null;
}
