import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname, "..");
/** Where screens live. They may only compose design-system components. */
const SCREEN_DIRS = ["routes", "screens", "blocks"];
/** The document skeleton is the one place raw elements are unavoidable. */
const DOCUMENT_ELEMENTS = new Set(["html", "head", "body"]);

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return files(full);
    return /\.(tsx?|jsx?)$/.test(e.name) && !e.name.includes(".test.") && e.name !== "routeTree.gen.ts" ? [full] : [];
  });
}

function violations(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const found: string[] = [];
  if (/\bstyle=/.test(text)) found.push("inline style=");
  if (/\bclassName=/.test(text)) found.push("className= (styling belongs in the design system)");
  for (const m of text.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) found.push(`raw colour ${m[0]}`);
  for (const m of text.matchAll(/import\s+[^;]*?["']([^"']+\.css(?:\?[^"']*)?)["']/g)) found.push(`CSS import ${m[1] ?? ""}`);
  for (const m of text.matchAll(/<([a-z][a-z0-9]*)[\s/>]/g)) {
    const tag = m[1] ?? "";
    if (!DOCUMENT_ELEMENTS.has(tag)) found.push(`raw <${tag}> element`);
  }
  return found;
}

describe("design system usage", () => {
  it("[HOME-7][QA-3] screens use only design-system components: no inline styles, raw colours, CSS imports or raw elements", () => {
    const report = SCREEN_DIRS.flatMap((d) => files(path.join(SRC, d))).flatMap((f) => violations(f).map((v) => `${path.relative(SRC, f)}: ${v}`));
    expect(report).toEqual([]);
  });

  it("raw colour values exist only in tokens.css", () => {
    const dsDir = path.join(SRC, "design-system");
    const offenders = files(dsDir)
      .concat(readdirSync(dsDir).filter((f) => f.endsWith(".css") && f !== "tokens.css").map((f) => path.join(dsDir, f)))
      .filter((f) => /#[0-9a-fA-F]{3,8}\b/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(SRC, f));
    expect(offenders).toEqual([]);
  });
});
