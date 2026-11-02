import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * CH-2 / CH-3: `sudo household-telegram ...` on the server. It checks its arguments itself, then runs
 * scripts/telegram.ts in the app's image with the house's .env as compose's env file, so the bot token
 * reaches the script without ever being on a command line. A stand-in `docker` records what it was given.
 */
const script = fileURLToPath(new URL("household-telegram.sh", import.meta.url));
/** HOU-168: made up per run, so no token-shaped literal is in the repo. */
const TOKEN = `123456:${randomBytes(18).toString("base64url")}`;
const WEBHOOK_SECRET = randomBytes(12).toString("hex");

function run(args: string[]): { status: number | null; docker: string | null; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "telegram-"));
  try {
    writeFileSync(join(dir, ".env"), `HOUSEHOLD_DOMAIN=house.example.test\nTELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_WEBHOOK_SECRET=${WEBHOOK_SECRET}\n`);
    writeFileSync(join(dir, "household.conf"), `HOUSEHOLD_DIR=${dir}\n`);
    writeFileSync(join(dir, "image"), `ghcr.io/calnicklin/household@sha256:${"a".repeat(64)}\n`);
    const fake = join(dir, "docker");
    writeFileSync(fake, `#!/usr/bin/env bash\n{ printf '%s\\n' "$*"; echo "image=$HOUSEHOLD_IMAGE env=$COMPOSE_ENV_FILES project=$COMPOSE_PROJECT_NAME"; } > "${join(dir, "docker.log")}"\n`);
    chmodSync(fake, 0o755);
    const result = spawnSync("bash", [script, ...args], { env: { PATH: `${dir}:${process.env["PATH"] ?? ""}`, HOUSEHOLD_CONF: join(dir, "household.conf") }, encoding: "utf8" });
    const log = join(dir, "docker.log");
    return { status: result.status, docker: existsSync(log) ? readFileSync(log, "utf8").replaceAll(dir, "<dir>") : null, stderr: result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("household-telegram", () => {
  it("[CH-2] refuses anything but connect, status, senders and set <person> <id>, before running anything", () => {
    for (const bad of [[], [""], ["connect", "x"], ["status", TOKEN], ["senders", "--all"], ["set"], ["set", "cal"], ["set", "cal", "12", "x"], ["set", "Cal", "12"], ["set", "cal;id", "12"], ["set", "cal", "012"], ["set", "cal", "12; reboot"], ["set", "cal", "-100"], ["connect; id"], ["help"]]) {
      const r = run(bad);
      expect(r.status, JSON.stringify(bad)).toBe(2);
      expect(r.docker, JSON.stringify(bad)).toBeNull();
      expect(r.stderr).toContain("usage: household-telegram");
    }
  });

  it("[CH-2][PRV-6] runs the script in the deployed image with the house's .env; the token is never an argument", () => {
    for (const args of [["connect"], ["status"], ["senders"], ["set", "cal", "123456789"]]) {
      const r = run(args);
      expect(r.status, r.stderr).toBe(0);
      expect(r.docker).toBe(`compose run --rm -T --no-deps app node scripts/telegram.ts ${args.join(" ")}\nimage=ghcr.io/calnicklin/household@sha256:${"a".repeat(64)} env=<dir>/.env project=household\n`);
      expect(r.docker).not.toContain(TOKEN);
      expect(r.stderr).not.toContain(TOKEN);
    }
  });

  it("[CH-2] is installed as a server command next to the others", () => {
    expect(readFileSync(new URL("install.sh", import.meta.url), "utf8")).toMatch(/^for c in [a-z ]*\btelegram\b[a-z ]*; do ln -sfn "\$lib\/household-\$c\.sh"/m);
  });
});
