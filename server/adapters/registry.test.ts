import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { loadAdapters } from "./registry.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const ADAPTERS = path.join(ROOT, "server", "adapters");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".") || name === "dist") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const adapterNames = () => readdirSync(ADAPTERS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

describe("adapters hold no business logic and can be deleted", () => {
  test("[CH-11] nothing outside an adapter's folder imports from it", () => {
    const offenders: string[] = [];
    const files = ["contracts", "server", "practice", "web", "helper", "tools", "scripts", "e2e"].flatMap((d) => {
      try {
        return sourceFiles(path.join(ROOT, d));
      } catch {
        return [];
      }
    });
    for (const name of adapterNames()) {
      const folder = path.join(ADAPTERS, name);
      for (const file of files) {
        if (file.startsWith(`${folder}${path.sep}`)) continue;
        const text = readFileSync(file, "utf8");
        for (const m of text.matchAll(/from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
          const spec = m[1] ?? m[2] ?? "";
          if (!spec.startsWith(".")) continue;
          const target = path.resolve(path.dirname(file), spec);
          if (target === folder || target.startsWith(`${folder}${path.sep}`)) offenders.push(`${path.relative(ROOT, file)} → ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("[CH-11] deleting an adapter's folder leaves the server able to load the rest", async () => {
    // Copy the adapters to a temp folder at the same depth (so relative imports still resolve), minus one.
    const copy = mkdtempSync(path.join(path.join(ROOT, "server"), ".adapters-copy-"));
    try {
      for (const name of readdirSync(ADAPTERS)) if (name !== "email") cpSync(path.join(ADAPTERS, name), path.join(copy, name), { recursive: true });
      const loaded = await loadAdapters(copy);
      const names = loaded.map((a) => a.name).sort();
      expect(names).not.toContain("email");
      expect(names).toEqual(adapterNames().filter((n) => n !== "email").sort());
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });
});
