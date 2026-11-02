import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ActionKind, type Attachment, AttachmentKind, Channel, JobStatus } from "@household/contracts";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { accept, identify } from "../../coordinator/accept.ts";
import type { Runtime } from "../../runtime.ts";
import { mcpArrivals, mcpBacklog, mcpToday } from "../../views/mcp.ts";
import type { Adapter } from "../registry.ts";

/** CH-9: exactly these tools. Reads of today, backlog and arrivals; writes of captures, modes and dismissals. No send. */
export const MCP_TOOLS = ["today", "backlog", "arrivals", "capture", "set_mode", "dismiss"] as const;

const MODE_WORDS = { slow: "slow day", sick: "sick day", away: "we're away", normal: "normal day" } as const;

/**
 * Bearer token → the person's MCP identity address. Practice mapping: `MCP_TOKEN` is Tom,
 * `MCP_TOKEN-priya` is Priya. A real house sets one token per person the same way.
 */
export function addressForToken(rt: Runtime, header: string | undefined): string | null {
  const token = /^Bearer\s+(.+)$/i.exec(header ?? "")?.[1]?.trim();
  if (token === undefined || token === "") return null;
  if (token === rt.env.MCP_TOKEN) return "tom";
  if (token === `${rt.env.MCP_TOKEN}-priya`) return "priya";
  return null;
}

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] });

/** A write becomes a normal message on the mcp channel; wait briefly for its job so the client gets the house's answer. */
async function say(rt: Runtime, person: string, words: string, attachments: Attachment[]) {
  const accepted = await accept(rt, {
    household: rt.env.HOUSEHOLD_ID,
    person,
    channel: Channel.mcp,
    text: words,
    attachments,
    dedupeKey: `mcp:${person}:${randomUUID()}`,
    receivedAt: rt.ports.clock.now().toISOString(),
  });
  const api = rt.system("mcp");
  for (let i = 0; i < 100; i++) {
    const job = await api.jobs.job({ id: accepted.jobId });
    if (job !== null && job.status !== JobStatus.running && job.status !== JobStatus.pending) {
      const reply = await api.jobs.replyFor({ id: accepted.messageId });
      return text({ jobId: accepted.jobId, status: job.status, reply: reply?.text ?? "" });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return text({ jobId: accepted.jobId, status: "running", reply: "" });
}

export function buildMcpServer(rt: Runtime, person: string): McpServer {
  const server = new McpServer({ name: "household", version: "1.0.0" });
  server.registerTool("today", { description: "Today's plan as the kitchen screen shows it: ordered blocks, each with its reason." }, async () => text(await mcpToday(rt, person)));
  server.registerTool("backlog", { description: "The shared backlog: could go soon, waiting, just added, parked." }, async () => text(await mcpBacklog(rt)));
  server.registerTool("arrivals", { description: "Parcels expected from order confirmations." }, async () => text(await mcpArrivals(rt)));
  server.registerTool("capture", { description: "Note a thought for the house (it lands on the backlog or the shop).", inputSchema: { text: z.string().min(1) } }, async ({ text: words }) => say(rt, person, words, []));
  // HOU-156: `when` sets it ahead ("this weekend", "on Friday"), read the same way as when said in words (MOM-8).
  server.registerTool(
    "set_mode",
    { description: "Set the house's day: slow, sick, away or normal. Starts now unless `when` names a later day or days ('this weekend', 'on Friday').", inputSchema: { mode: z.enum(["slow", "sick", "away", "normal"]), when: z.string().min(1).optional() } },
    async ({ mode, when }) => say(rt, person, when === undefined ? MODE_WORDS[mode] : `${MODE_WORDS[mode]} ${when}`, []),
  );
  server.registerTool("dismiss", { description: "Dismiss something on today's screen by its ref, with no guilt.", inputSchema: { ref: z.string().min(1) } }, async ({ ref }) =>
    say(rt, person, "Not today", [{ kind: AttachmentKind.ref, ref, action: ActionKind.notToday }]),
  );
  return server;
}

export const adapter: Adapter = {
  name: "mcp",
  routes: (app, rt) => {
    app.all("/mcp", async (c) => {
      const address = addressForToken(rt, c.req.header("authorization"));
      const person = address === null ? null : await identify(rt, Channel.mcp, address);
      if (person === null) return c.json({ error: "a valid MCP token is required" }, 401);
      const server = buildMcpServer(rt, person);
      // Stateless: no session id generator, one server per request.
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await server.connect(transport);
      return transport.handleRequest(c.req.raw);
    });
  },
};
