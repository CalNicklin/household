import { Practice } from "@household/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Hono } from "hono";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { TestHousehold } from "../../testing/household.ts";
import { householdWithApp } from "../../testing/http.ts";
import type { HttpEnv } from "../registry.ts";
import { MCP_TOOLS } from "./index.ts";

let h: TestHousehold;
let app: Hono<HttpEnv>;

beforeAll(async () => {
  ({ h, app } = await householdWithApp());
});
afterAll(async () => h.close());

async function client(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL("http://household.test/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: async (url, init) => app.request(url.toString(), init),
  });
  const c = new Client({ name: "test-claude", version: "1.0.0" });
  await c.connect(transport);
  return c;
}

const zToolResult = z.object({ content: z.array(z.object({ type: z.string(), text: z.string().optional() })).default([]) });
const textOf = (result: unknown): string =>
  zToolResult
    .parse(result)
    .content.map((p) => p.text ?? "")
    .join("");

describe("MCP server", () => {
  test("[CH-9] exactly six tools: read today, backlog, arrivals; write captures, modes, dismissals — no send", async () => {
    const c = await client(Practice.settings.MCP_TOKEN);
    const tools = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual([...MCP_TOOLS].sort());
    expect(tools.some((t) => /send|notify|message/.test(t))).toBe(false);
    await c.close();
  });

  test("[CH-9][CH-2] reads come from the query layer: today, backlog, arrivals", async () => {
    const c = await client(Practice.settings.MCP_TOKEN);
    expect(textOf(await c.callTool({ name: "backlog", arguments: {} }))).toContain("Service the bike");
    expect(textOf(await c.callTool({ name: "arrivals", arguments: {} }))).toContain("Ocado");
    expect(textOf(await c.callTool({ name: "today", arguments: {} }))).toContain("2026-11-02");
    await c.close();
  });

  test("[CH-9][CH-2][CH-3] a capture via MCP is a normal message from that person and lands on the backlog", async () => {
    const c = await client(`${Practice.settings.MCP_TOKEN}-priya`);
    const out = textOf(await c.callTool({ name: "capture", arguments: { text: "sort out the spare room" } }));
    expect(out).toContain("succeeded");
    const item = (await h.rt.system("test").backlog.list()).find((i) => i.text === "Sort out the spare room");
    expect(item).toMatchObject({ createdBy: "priya", createdVia: "mcp" });
    await c.close();
  });

  test("[CH-9] set_mode slow makes the whole house a slow day", async () => {
    const c = await client(Practice.settings.MCP_TOKEN);
    await c.callTool({ name: "set_mode", arguments: { mode: "slow" } });
    const mode = await h.rt.system("test").household.activeMode();
    expect(mode).toMatchObject({ mode: "slow", setBy: "tom" });
    await c.callTool({ name: "set_mode", arguments: { mode: "normal" } });
    expect(await h.rt.system("test").household.activeMode()).toBeNull();
    await c.close();
  });

  test("[CH-9][MOM-8] set_mode with `when` sets it ahead, as saying it would", async () => {
    const c = await client(Practice.settings.MCP_TOKEN);
    await c.callTool({ name: "set_mode", arguments: { mode: "away", when: "this weekend" } });
    expect(await h.rt.system("test").household.activeMode()).toBeNull();
    const modes = await h.rt.system("test").household.modesBetween({ from: "2026-11-07T12:00:00Z", to: "2026-11-07T13:00:00Z" });
    expect(modes).toMatchObject([{ mode: "away", setBy: "tom", startsAt: "2026-11-07T00:00:00.000Z", endsAt: "2026-11-09T00:00:00.000Z" }]);
    await c.callTool({ name: "set_mode", arguments: { mode: "normal", when: "this weekend" } });
    expect(await h.rt.system("test").household.modesBetween({ from: "2026-11-07T00:00:00Z", to: "2026-11-09T00:00:00Z" })).toEqual([]);
    await c.close();
  });

  test("[CH-9] dismiss records a no-guilt not-today on the ref", async () => {
    const c = await client(Practice.settings.MCP_TOKEN);
    await c.callTool({ name: "dismiss", arguments: { ref: "washing:2026-11-02" } });
    const responses = await h.rt.system("test").plans.responsesForRef({ ref: "washing:2026-11-02" });
    expect(responses).toContainEqual(expect.objectContaining({ action: "not-today", channel: "mcp", person: "tom" }));
    await c.close();
  });

  test("[PRV-6][CH-3] /mcp refuses a missing or unknown token", async () => {
    expect((await app.request("/mcp", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await app.request("/mcp", { method: "POST", headers: { authorization: "Bearer guess" }, body: "{}" })).status).toBe(401);
    await expect(client("nope")).rejects.toThrow(/401|token/i);
  });
});
