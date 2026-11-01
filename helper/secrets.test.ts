import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { createHelperApp } from "./app.ts";
import { loadTasks } from "./registry.ts";
import { createRedactor, createRunLog, readLockedCredentials } from "./secrets.ts";

const dir = () => mkdtempSync(path.join(tmpdir(), "helper-secrets-"));

describe("the locked store", () => {
  test("[AUT-2] credentials readable by anyone but the helper are refused", () => {
    const file = path.join(dir(), "supermarket.json");
    writeFileSync(file, JSON.stringify({ url: "http://x", username: "u", password: "p" }), { mode: 0o644 });
    chmodSync(file, 0o644);
    expect(() => readLockedCredentials(file)).toThrow(/readable by others/);
    chmodSync(file, 0o600);
    expect(readLockedCredentials(file).username).toBe("u");
  });

  test("[AUT-2] the redactor removes the login from every log line", () => {
    const lines: string[] = [];
    const log = createRunLog(createRedactor(["hunter2", "shopper@example.com"]), (l) => lines.push(l));
    log.line("signing in as shopper@example.com with hunter2 (hunter2%20)");
    expect(log.lines()[0]).not.toMatch(/hunter2|shopper@example\.com/);
    expect(lines.join("")).not.toMatch(/hunter2|shopper@example\.com/);
  });
});

describe("helper task registry", () => {
  test("[AUT-7] a second helper is a new folder: it is mounted without changing anything else", async () => {
    const tasksDir = dir();
    mkdirSync(path.join(tasksDir, "mot"));
    writeFileSync(
      path.join(tasksDir, "mot", "index.ts"),
      `export const task = { name: "mot", routes: (app) => { app.get("/next-slot", (c) => c.json({ slot: "2027-01-12" })); } };\n`,
    );
    const tasks = await loadTasks(tasksDir);
    expect(tasks.map((t) => t.name)).toEqual(["mot"]);
    const { app, close } = await createHelperApp({ token: "t", credentials: { url: "http://x", username: "u", password: "p" }, dataDir: dir(), tasks });
    const res = await app.request("/tasks/mot/next-slot", { headers: { authorization: "Bearer t" } });
    expect(await res.json()).toEqual({ slot: "2027-01-12" });
    expect(await (await app.request("/tasks", { headers: { authorization: "Bearer t" } })).json()).toEqual(["mot"]);
    await close();
  });

  test("[AUT-7] the real registry finds the shopping helper by its folder", async () => {
    expect((await loadTasks()).map((t) => t.name)).toContain("shopping");
  });
});
