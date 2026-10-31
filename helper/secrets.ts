import { readFileSync, statSync } from "node:fs";
import { z } from "zod";

const zCredentials = z.object({ url: z.string(), username: z.string().min(1), password: z.string().min(1) });
export type Credentials = z.infer<typeof zCredentials>;

/**
 * AUT-2: the supermarket login lives in a locked store — a file only this helper's user can read
 * (a Docker secret in production). Anything group- or world-readable is refused.
 */
export function readLockedCredentials(file: string): Credentials {
  const mode = statSync(file).mode;
  if ((mode & 0o077) !== 0) throw new Error(`refusing to start: ${file} is readable by others (mode ${(mode & 0o777).toString(8)}); chmod 600 it`);
  return zCredentials.parse(JSON.parse(readFileSync(file, "utf8")));
}

/** Replaces every secret (and its URL-encoded form) with *** so it can never reach a log or a response. */
export function createRedactor(secrets: readonly string[]): (text: string) => string {
  const needles = [...new Set(secrets.flatMap((s) => (s.length > 0 ? [s, encodeURIComponent(s)] : [])))].sort((a, b) => b.length - a.length);
  return (text) => {
    let out = text;
    for (const n of needles) out = out.split(n).join("***");
    return out;
  };
}

export type Logger = { line(text: string): string; lines(): string[] };

/** A run log: timestamped, redacted lines, echoed to stdout as JSON (AUT-6). */
export function createRunLog(redact: (text: string) => string, sink: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): Logger {
  const lines: string[] = [];
  return {
    line(text) {
      const entry = `${new Date().toISOString()} ${redact(text)}`;
      lines.push(entry);
      sink(JSON.stringify({ helper: entry }));
      return entry;
    },
    lines: () => [...lines],
  };
}
