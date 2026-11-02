import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Domain, LimitReason, Limits } from "@household/contracts";
import { createTableRelationsHelpers, extractTablesRelationalConfig, is, One } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { schemas } from "../server/runtime.ts";
import { falseLine, loadVerifications } from "./reporters/verifications.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const SKIP = new Set(["node_modules", ".git", ".data", "dist", ".claude", "test-results", "evidence", "design"]);

function files(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    // The CH-11 test (server/adapters/registry.test.ts) briefly copies server/adapters to `.adapters-copy-*`.
    if (SKIP.has(name) || name.startsWith(".adapters-copy-")) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p, ext));
    else if (ext.test(name)) out.push(p);
  }
  return out;
}
const rel = (p: string) => path.relative(ROOT, p);
const source = files(ROOT, /\.(ts|tsx)$/).filter((f) => !f.endsWith("routeTree.gen.ts"));
const importsOf = (file: string) => [...readFileSync(file, "utf8").matchAll(/(?:import|export)[^"']*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1] ?? m[2] ?? "");

describe("Code rules that a tool enforces", () => {
  test("[CODE-1] contracts imports nothing from anywhere else in the repo, and every enumerated value is an as-const object", () => {
    for (const f of source.filter((x) => rel(x).startsWith("contracts/"))) {
      for (const spec of importsOf(f)) expect(spec === "zod" || spec.startsWith("./"), `${rel(f)} imports ${spec}`).toBe(true);
      const text = readFileSync(f, "utf8");
      expect(text, `${rel(f)} defines a hand-written string union`).not.toMatch(/type \w+ = "[^"]+"\s*\|/);
    }
    for (const f of source.filter((x) => rel(x).startsWith("server/domains/") && x.endsWith("schema.ts"))) expect(readFileSync(f, "utf8")).not.toMatch(/pgEnum/);
  });

  test("[CODE-2] schemas take enumerated values from contracts (contracts → schema → app)", () => {
    for (const f of source.filter((x) => /server\/domains\/[^/]+\/schema\.ts$/.test(rel(x)))) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/\{ enum: values\((\w+)\) \}/g)) expect(text).toMatch(new RegExp(`\\b${m[1]}\\b[^;]*from "@household/contracts"|import \\{[^}]*\\b${m[1]}\\b[^}]*\\} from "@household/contracts"`));
      expect(text).not.toMatch(/enum: \[/);
    }
  });

  test("[CODE-3] the front end takes labels and options from contracts; no value is spelled twice", () => {
    const web = source.filter((x) => rel(x).startsWith("web/src/") && !x.endsWith(".test.ts") && !x.endsWith(".test.tsx"));
    expect(web.some((f) => readFileSync(f, "utf8").includes("@household/contracts"))).toBe(true);
    const spelled = ["not-today", "backlog-pick", "both-home", "office-hours", "phone-call", "half-day"];
    for (const f of web) for (const v of spelled) expect(readFileSync(f, "utf8"), `${rel(f)} spells "${v}"`).not.toContain(`"${v}"`);
  });

  test("[CODE-4][PLT-3] each domain has its own schema, migrations and database; no domain reads another's tables", () => {
    for (const d of Object.values(Domain)) {
      expect(statSync(path.join(ROOT, "server/domains", d, "migrations")).isDirectory()).toBe(true);
      expect(readFileSync(path.join(ROOT, "server/domains", d, "drizzle.config.ts"), "utf8")).toContain(`_${d}`);
      for (const f of source.filter((x) => rel(x).startsWith(`server/domains/${d}/`)))
        for (const spec of importsOf(f)) expect(spec.includes("/domains/") && !spec.includes(`/domains/${d}/`), `${rel(f)} → ${spec}`).toBe(false);
    }
  });

  test("[CODE-5] each domain exposes exactly one tRPC router, and its inputs and outputs come from contracts", () => {
    for (const d of Object.values(Domain)) {
      const text = readFileSync(path.join(ROOT, "server/domains", d, "router.ts"), "utf8");
      expect(text.match(/export function \w+Router\(/g)).toHaveLength(1);
      expect(text).toContain("@household/contracts");
    }
  });

  test("[CODE-6] every foreign key is declared twice: on the column and as a relations() entry", () => {
    for (const [domain, mod] of Object.entries(schemas)) {
      const config = extractTablesRelationalConfig(mod, createTableRelationsHelpers);
      for (const [name, value] of Object.entries(mod)) {
        if (!is(value, PgTable)) continue;
        const relations = Object.values(config.tables[name]?.relations ?? {});
        for (const fk of getTableConfig(value).foreignKeys) {
          const cols = fk.reference().columns.map((c) => c.name).join(",");
          const declared = relations.some((r) => is(r, One) && r.config?.fields.map((f) => f.name).join(",") === cols);
          expect(declared, `${domain}.${name}(${cols}) has no relations() entry`).toBe(true);
        }
      }
    }
  });

  test("[CODE-9] AGENTS.md is under 60 lines and says how to pick a task, where types live, how to check, how to hand over", () => {
    const text = readFileSync(path.join(ROOT, "AGENTS.md"), "utf8");
    expect(text.trimEnd().split("\n").length).toBeLessThan(60);
    for (const must of ["Pick work", "contracts/", "pnpm check", "Hand it over"]) expect(text).toContain(must);
  });

  test("[CODE-10] TypeScript is strict with noUncheckedIndexedAccess and exactOptionalPropertyTypes", () => {
    const cfg = z.object({ compilerOptions: z.record(z.string(), z.unknown()) }).parse(JSON.parse(readFileSync(path.join(ROOT, "tsconfig.json"), "utf8")));
    expect(cfg.compilerOptions).toMatchObject({ strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noEmit: true });
  });

  test("[CODE-7][CODE-8] oxlint runs the strict rules: no any, no non-null assertion, exhaustive switch, no default exports, sorted imports", () => {
    const cfg = z.object({ rules: z.record(z.string(), z.unknown()) }).parse(JSON.parse(readFileSync(path.join(ROOT, ".oxlintrc.json"), "utf8")));
    for (const r of ["typescript/no-explicit-any", "typescript/no-non-null-assertion", "typescript/switch-exhaustiveness-check", "import/no-default-export", "sort-imports", "household/cited-limits"]) expect(cfg.rules[r], r).toBeDefined();
    const fallow = z.object({ rules: z.record(z.string(), z.string()) }).parse(JSON.parse(readFileSync(path.join(ROOT, ".fallowrc.json"), "utf8")));
    expect(fallow.rules["unused-exports"]).toBe("error");
  });

  test("[PLT-11] the app reads from the query layer and listens for changes; it never calls the agent", () => {
    for (const f of source.filter((x) => rel(x).startsWith("web/src/"))) {
      const text = readFileSync(f, "utf8");
      const serverImports = [...text.matchAll(/^import (type )?[^;]*from ["']([^"']+)["']/gm)].filter((m) => (m[2] ?? "").includes("/server/"));
      for (const m of serverImports) expect(`${m[1] ?? "value "}${m[2] ?? ""}`, rel(f)).toMatch(/^type .*server\/views\//);
      expect(text).not.toMatch(/from ["'][^"']*server\/agent/);
    }
    const live = source.find((f) => rel(f) === "web/src/data/live.ts");
    expect(live === undefined ? "" : readFileSync(live, "utf8")).toContain("EventSource");
  });

  test("[CODE-8][CODE-11] pnpm check is the one command: tsc, oxlint, fallow audit, drizzle-kit check, tests; CI runs nothing else", () => {
    const check = readFileSync(path.join(ROOT, "scripts/check.ts"), "utf8");
    for (const step of ['"tsc"', '"oxlint"', '"fallow", "audit"', "drizzle.ts", '"vitest"', '"playwright"']) expect(check).toContain(step);
    const ci = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
    expect([...ci.matchAll(/- run: (.+)/g)].map((m) => m[1])).toEqual(["pnpm install --frozen-lockfile", "pnpm exec playwright install --with-deps chromium webkit", "pnpm check"]);
    const fallow = z.object({ boundaries: z.object({ zones: z.array(z.object({ name: z.string() })), rules: z.array(z.object({ from: z.string(), allow: z.array(z.string()) })) }) }).parse(JSON.parse(readFileSync(path.join(ROOT, ".fallowrc.json"), "utf8")));
    expect(fallow.boundaries.rules.find((r) => r.from === "contracts")?.allow).toEqual([]);
    for (const d of Object.values(Domain)) expect(fallow.boundaries.rules.find((r) => r.from === `domain-${d}`)?.allow).toEqual(["contracts", "infra"]);
  });

  test("[FB-3] every line in Morning glance, Capture, In the moment, Proactive nudges and Automations has a Playwright journey", () => {
    const journeys = files(path.join(ROOT, "e2e"), /\.spec\.ts$/).map((f) => readFileSync(f, "utf8")).join("\n");
    const userFacing = [...loadVerifications().keys()].filter((id) => /^(HOME|CAP|MOM|PRO|AUT)-/.test(id));
    expect(userFacing.length).toBe(47);
    for (const id of userFacing) expect(journeys, `${id} has no journey`).toContain(`[${id}]`);
  });

  test("[CODE-12][PLT-9] no provider SDK is imported anywhere except the one model file; the provider is a setting", () => {
    for (const f of source) {
      if (rel(f) === "server/agent/model.ts") continue;
      for (const spec of importsOf(f)) expect(/^@ai-sdk\/(anthropic|openai|google|mistral)|^openai$|^@anthropic-ai\//.test(spec), `${rel(f)} imports ${spec}`).toBe(false);
    }
    expect(readFileSync(path.join(ROOT, "server/env.ts"), "utf8")).toContain("MODEL_PROVIDER");
  });

  test("[CODE-13] a limit with no cited reason is a lint failure", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "limits-")), "bad.ts");
    writeFileSync(file, "export const x = { maxOutputTokens: 500, signal: AbortSignal.timeout(1000) };\n");
    let out = "";
    try {
      execFileSync("pnpm", ["exec", "oxlint", "-c", ".oxlintrc.json", file], { cwd: ROOT, encoding: "utf8", stdio: "pipe" });
    } catch (e) {
      out = z.object({ stdout: z.string() }).parse(e).stdout;
    }
    expect(out).toContain("cited-limits");
    expect(out).toContain("maxOutputTokens");
    expect(out).toContain("AbortSignal.timeout");
  });

  test("[CODE-14][CODE-15] every limit is a named constant in contracts/limits.ts citing an allowed reason", () => {
    for (const [name, limit] of Object.entries(Limits)) {
      expect(Object.keys(LimitReason), name).toContain(limit.reason);
      expect(limit.note.length, name).toBeGreaterThan(10);
    }
    for (const [name, limit] of Object.entries(Limits).filter(([, l]) => l.reason === "VERIFICATION")) {
      expect(limit.note, name).toMatch(/^[A-Z]{2,4}-\d+/);
    }
    for (const f of source.filter((x) => !rel(x).startsWith("contracts/") && !rel(x).startsWith("tools/"))) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/\/\/ limit: (\w+)/g)) expect(Object.keys(Limits), `${rel(f)} cites ${m[1]}`).toContain(m[1]);
    }
  });

  test("[FB-7] a failure prints the verification ID and a plain line first", () => {
    const line = falseLine(loadVerifications(), "[CAP-1] a capture shows up", "expected 1 to be 2");
    expect(line.split("\n")[0]).toBe("FALSE CAP-1: Type or say a thought anywhere (the app, WhatsApp, email) and it appears on the Backlog for both of us within five seconds.");
    expect(loadVerifications().size).toBeGreaterThanOrEqual(120);
  });
});
