import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

function flatten(value: unknown, prefix: string, out: Map<string, string>): void {
  if (typeof value === "string") {
    out.set(prefix, value);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith("$")) continue;
    flatten(child, prefix === "" ? key : `${prefix}-${key}`, out);
  }
}

describe("design tokens", () => {
  it("[QA-3] tokens.css declares exactly the shared token set in design/tokens.json", () => {
    const json: unknown = JSON.parse(readFileSync(path.join(ROOT, "design", "tokens.json"), "utf8"));
    const expected = new Map<string, string>();
    flatten(json, "", expected);

    const css = readFileSync(path.join(import.meta.dirname, "tokens.css"), "utf8");
    const actual = new Map<string, string>();
    for (const m of css.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) if (m[1] !== undefined && m[2] !== undefined) actual.set(m[1], m[2].trim());

    expect(Object.fromEntries(actual)).toEqual(Object.fromEntries(expected));
  });
});
