import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTRPC } from "../data/trpc.ts";
import { Header, Image, Page, Section, Stack, Table, Text } from "../design-system/index.ts";
import { navFor } from "./common.tsx";

const when = (iso: string | null) => (iso === null ? "—" : new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }));
const money = (micros: number) => `$${(micros / 1_000_000).toFixed(micros < 10_000 ? 4 : 2)}`;

/** CH-5 / PLT-2: every job and every timer, with missed timers called out. */
export function RunLogScreen() {
  const trpc = useTRPC();
  const log = useQuery(trpc.runLog.queryOptions());
  const jobs = log.data?.jobs ?? [];
  const timers = log.data?.timers ?? [];
  return (
    <Page label="Run log">
      <Header title="Run log" line="Every job the house ran, and every timer" nav={[...navFor("/runs"), { to: "/spend", label: "Spend" }]} />
      <Stack>
        <Section label="Timers">
          <Table
            label="Timers"
            head={["Timer", "Due", "Fired"]}
            rows={timers.map((t) => [t.timer, when(t.scheduledFor), t.missed ? (
                <Text key="missed" tone="alert">
                  Missed
                </Text>
              ) : (
                when(t.firedAt)
              ),
            ])}
          />
        </Section>
        <Section label="Jobs">
          <Table
            label="Jobs"
            head={["When", "From", "What", "Status", "Tokens", "Cost"]}
            rows={jobs.map((j) => [
              <Link key={j.id} to="/trace/$id" params={{ id: j.id }}>
                {when(j.createdAt)}
              </Link>,
              `${j.channel}${j.person === null ? "" : ` · ${j.person}`}`,
              j.intent,
              j.status,
              `${j.inputTokens} in / ${j.outputTokens} out`,
              money(j.costMicros),
            ])}
          />
        </Section>
      </Stack>
    </Page>
  );
}

/** AUT-6: a shopping run's log and screenshots, opened from the message that started it. */
export function RunScreen({ id }: { id: string }) {
  const trpc = useTRPC();
  const run = useQuery(trpc.run.queryOptions({ id }));
  const data = run.data;
  return (
    <Page label="Shopping run">
      <Header title={data === null || data === undefined ? "Shopping run" : `Shopping: ${data.item}`} line={data?.chosen === null || data?.chosen === undefined ? (data?.status ?? "") : `${data.status} · ${data.chosen.name}`} nav={navFor("/runs")} />
      {data === null ? <Text tone="muted">No run with that id.</Text> : null}
      <Stack>
        <Section label="Log">
          <Table label="Log" head={["When", "What happened"]} rows={(data?.log ?? []).map((l) => [when(l.at), l.line])} />
        </Section>
        <Section label="Screenshots">
          {(data?.screenshots ?? []).map((s) => (
            <Stack key={s.url} tight>
              <Text tone="muted" small>
                {s.name}
              </Text>
              <Image src={s.url} alt={s.name} />
            </Stack>
          ))}
        </Section>
      </Stack>
    </Page>
  );
}

/** PLT-2 / QA-8: one job's whole history in one place. */
export function TraceScreen({ id }: { id: string }) {
  const trpc = useTRPC();
  const trace = useQuery(trpc.trace.queryOptions({ id }));
  const data = trace.data;
  if (data === null || data === undefined) {
    return (
      <Page label="Job trace">
        <Header title="Job" nav={navFor("/runs")} />
        <Text tone="muted">{trace.isPending ? "Loading…" : "No job with that id."}</Text>
      </Page>
    );
  }
  const job = data.job;
  return (
    <Page label="Job trace">
      <Header title={`Job ${job.intent === "" ? "" : `· ${job.intent}`}`} line={`${job.status} · ${job.channel} · ${when(job.createdAt)} · ${job.durationMs} ms · ${money(job.costMicros)}`} nav={navFor("/runs")} />
      <Stack>
        <Section label="Model">
          <Text>{`${job.provider} / ${job.model} — ${job.inputTokens} tokens in, ${job.outputTokens} out`}</Text>
          {job.error === null ? null : <Text tone="alert">{job.error}</Text>}
        </Section>
        <Section label="Steps">
          <Table label="Steps" head={["Step", "Started", "Finished", "Notes"]} rows={data.steps.map((s) => [s.name, when(s.startedAt), when(s.completedAt), s.error ?? (s.childWorkflowId === null ? "" : `child ${s.childWorkflowId}`)])} />
        </Section>
        <Section label="Tool calls">
          <Table label="Tool calls" head={["Tool", "Input", "Output"]} rows={job.toolCalls.map((c) => [c.tool, <Text key="i" mono>{JSON.stringify(c.input)}</Text>, <Text key="o" mono>{JSON.stringify(c.output)}</Text>])} />
        </Section>
      </Stack>
    </Page>
  );
}

/** QA-8: monthly AI spend. */
export function SpendScreen() {
  const trpc = useTRPC();
  const spend = useQuery(trpc.spend.queryOptions());
  const months = spend.data?.months ?? [];
  return (
    <Page label="AI spend">
      <Header title="AI spend" line="What the model calls cost, by month" nav={[...navFor("/spend"), { to: "/runs", label: "Run log" }]} />
      <Table label="AI spend by month" head={["Month", "Cost", "Jobs", "Tokens in", "Tokens out"]} rows={months.map((m) => [m.month, money(m.costMicros), String(m.jobs), String(m.inputTokens), String(m.outputTokens)])} />
      {months.length === 0 ? <Text tone="muted">No model calls yet.</Text> : null}
    </Page>
  );
}
