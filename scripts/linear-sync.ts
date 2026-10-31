import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * QA-1 / QA-2: every line of VERIFICATIONS.md as a Linear issue with the same ID in its title, in one
 * project, labelled `verification`, with blocked-by links from each (gate) line to the rest of its
 * section. Idempotent: run it again after editing the doc.
 *
 *   LINEAR_API_KEY=… LINEAR_TEAM_ID=<team uuid> node scripts/linear-sync.ts   (or LINEAR_TEAM_KEY=HOU)
 *
 * With `--evidence`, posts the evidence (evidence/vitest.json, evidence/playwright.json, and the runs in
 * evidence/manual.json) as a comment on each issue whose tests all pass, and the reason on each line in
 * evidence/not-true.json. Each comment is posted once.
 */
const API = "https://api.linear.app/graphql";
const key = process.env["LINEAR_API_KEY"];
const teamKey = process.env["LINEAR_TEAM_KEY"];
const teamId = process.env["LINEAR_TEAM_ID"];
const projectName = process.env["LINEAR_PROJECT"] ?? "Household Coordinator — Verifications";
if (key === undefined || (teamKey === undefined && teamId === undefined)) {
  console.error("set LINEAR_API_KEY and LINEAR_TEAM_ID (or LINEAR_TEAM_KEY)");
  process.exit(2);
}

async function gql<T>(schema: z.ZodType<T>, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(API, { method: "POST", headers: { "content-type": "application/json", authorization: key ?? "" }, body: JSON.stringify({ query, variables }) });
  const body = z.object({ data: z.unknown().optional(), errors: z.array(z.object({ message: z.string() })).optional() }).parse(await res.json());
  if (body.errors !== undefined && body.errors.length > 0) throw new Error(body.errors.map((e) => e.message).join("; "));
  return schema.parse(body.data);
}

type Line = { id: string; text: string; gate: boolean; section: string };
const ROOT = path.resolve(import.meta.dirname, "..");
const lines: Line[] = [];
let section = "";
for (const raw of readFileSync(path.join(ROOT, "VERIFICATIONS.md"), "utf8").split("\n")) {
  const h = /^## (.+)$/.exec(raw);
  if (h?.[1] !== undefined) section = h[1];
  const m = /^- \[[ x]\] ([A-Z]{2,4}-\d{1,2}) (\*\*\(gate\)\*\* )?(.*)$/.exec(raw);
  if (m?.[1] !== undefined && m[3] !== undefined) lines.push({ id: m[1], text: m[3].replaceAll("**", ""), gate: m[2] !== undefined, section });
}

const zId = z.object({ id: z.string() });
const team = (await gql(z.object({ teams: z.object({ nodes: z.array(zId.extend({ key: z.string() })) }) }), "query { teams { nodes { id key } } }")).teams.nodes.find((t) => t.id === teamId || t.key === teamId || t.key === teamKey);
if (team === undefined) throw new Error(`no team ${teamId ?? teamKey ?? ""}`);

const labels = await gql(z.object({ issueLabels: z.object({ nodes: z.array(zId.extend({ name: z.string() })) }) }), "query { issueLabels(first: 250) { nodes { id name } } }");
const label =
  labels.issueLabels.nodes.find((l) => l.name === "verification") ??
  (await gql(z.object({ issueLabelCreate: z.object({ issueLabel: zId }) }), "mutation($teamId: String!) { issueLabelCreate(input: { name: \"verification\", teamId: $teamId }) { issueLabel { id } } }", { teamId: team.id })).issueLabelCreate.issueLabel;

const projects = await gql(z.object({ projects: z.object({ nodes: z.array(zId.extend({ name: z.string() })) }) }), "query { projects(first: 250) { nodes { id name } } }");
const project =
  projects.projects.nodes.find((p) => p.name === projectName) ??
  (await gql(z.object({ projectCreate: z.object({ project: zId }) }), "mutation($name: String!, $teamId: String!) { projectCreate(input: { name: $name, teamIds: [$teamId] }) { project { id } } }", { name: projectName, teamId: team.id })).projectCreate.project;

const existing = await gql(
  z.object({ project: z.object({ issues: z.object({ nodes: z.array(zId.extend({ title: z.string() })) }) }) }),
  "query($id: String!) { project(id: $id) { issues(first: 250) { nodes { id title } } } }",
  { id: project.id },
);
const byId = new Map<string, string>();
for (const issue of existing.project.issues.nodes) {
  const id = /^([A-Z]{2,4}-\d{1,2})\b/.exec(issue.title)?.[1];
  if (id !== undefined) byId.set(id, issue.id);
}
for (const line of lines) {
  const title = `${line.id} ${line.gate ? "(gate) " : ""}${line.text}`.slice(0, 250);
  const description = `${line.text}\n\nSection: ${line.section}\n\nDone only when its evidence (test names, screenshots, log lines) is attached here (QA-1).`;
  const known = byId.get(line.id);
  if (known === undefined) {
    const created = await gql(
      z.object({ issueCreate: z.object({ issue: zId }) }),
      "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id } } }",
      { input: { teamId: team.id, projectId: project.id, labelIds: [label.id], title, description } },
    );
    byId.set(line.id, created.issueCreate.issue.id);
  } else {
    await gql(z.unknown(), "mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }", { id: known, input: { title, description } });
  }
}

// QA-2: a (gate) line blocks the lines after it in its section, up to the next gate (Code has two).
for (const [i, gate] of lines.entries()) {
  if (!gate.gate) continue;
  const gateIssue = byId.get(gate.id);
  if (gateIssue === undefined) continue;
  const rest = lines.slice(i + 1);
  const until = rest.findIndex((l) => l.gate || l.section !== gate.section);
  for (const other of until === -1 ? rest : rest.slice(0, until)) {
    const blocked = byId.get(other.id);
    if (blocked === undefined) continue;
    await gql(z.unknown(), "mutation($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { success } }", { input: { issueId: gateIssue, relatedIssueId: blocked, type: "blocks" } }).catch(() => undefined);
  }
}

if (process.argv.includes("--evidence")) {
  const zRun = z.array(z.object({ ids: z.array(z.string()), test: z.string(), file: z.string(), state: z.string(), attachments: z.array(z.string()).optional() }));
  const read = (f: string) => zRun.parse(JSON.parse(readFileSync(path.join(ROOT, "evidence", f), "utf8")));
  const notes = z.record(z.string(), z.string());
  const manual = notes.parse(JSON.parse(readFileSync(path.join(ROOT, "evidence", "manual.json"), "utf8")));
  const notTrue = notes.parse(JSON.parse(readFileSync(path.join(ROOT, "evidence", "not-true.json"), "utf8")));
  const runs = [...read("vitest.json").map((r) => ({ ...r, kind: "test" })), ...read("playwright.json").map((r) => ({ ...r, kind: "journey" }))];
  const commit = process.env["GIT_COMMIT"] ?? "";
  for (const line of lines) {
    const issue = byId.get(line.id);
    if (issue === undefined) continue;
    const posted = await gql(z.object({ issue: z.object({ comments: z.object({ nodes: z.array(z.object({ body: z.string() })) }) }) }), "query($id: String!) { issue(id: $id) { comments(first: 50) { nodes { body } } } }", { id: issue });
    const already = (marker: string) => posted.issue.comments.nodes.some((c) => c.body.includes(marker) || (marker.endsWith(":proven -->") && c.body.startsWith("**Evidence")) || (marker.endsWith(":not-true -->") && c.body.startsWith("**Not true yet")));
    const mine = runs.filter((r) => r.ids.includes(line.id));
    const reason = notTrue[line.id];
    let body: string | null = null;
    if (reason !== undefined) body = `**Not true yet.** ${reason}`;
    else if (mine.length > 0 && mine.every((r) => r.state === "passed" || r.state === "pass"))
      body = [
        `**Evidence${commit === "" ? "" : ` at ${commit.slice(0, 8)}`}** (\`pnpm check\` green):`,
        ...mine.map((r) => `- ✅ ${r.kind} \`${r.file}\` — ${r.test.replace(/\[[A-Z]{2,4}-\d{1,2}\]/g, "").trim()}${(r.attachments ?? []).length > 0 ? ` (screenshot: ${(r.attachments ?? []).join(", ")})` : ""}`),
      ].join("\n");
    else if (manual[line.id] !== undefined) body = `**Evidence (run, not a test):** ${manual[line.id]}`;
    if (body === null) continue;
    const marker = `<!-- evidence:${line.id}:${reason === undefined ? "proven" : "not-true"} -->`;
    if (already(marker)) continue;
    await gql(z.unknown(), "mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }", { input: { issueId: issue, body: `${body}\n\n${marker}` } });
  }
}
console.log(JSON.stringify({ event: "linear-synced", issues: byId.size, gates: lines.filter((l) => l.gate).map((l) => l.id) }));
