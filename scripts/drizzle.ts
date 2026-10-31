import { execFileSync } from "node:child_process";
import { Domain } from "@household/contracts";

/** Runs a drizzle-kit command once per domain: each domain has its own schema and migrations (CODE-4). */
const command = process.argv[2] ?? "check";
const extra = command === "generate" ? ["--name", process.argv[3] ?? "change"] : [];
for (const domain of Object.values(Domain)) {
  process.stdout.write(`drizzle-kit ${command} ${domain}\n`);
  execFileSync("pnpm", ["exec", "drizzle-kit", command, "--config", `server/domains/${domain}/drizzle.config.ts`, ...extra], { stdio: "inherit" });
}
