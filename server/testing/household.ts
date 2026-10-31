import { randomBytes, randomUUID } from "node:crypto";
import { type ActionKind, type Attachment, AttachmentKind, type Channel, Channel as Channels, Domain } from "@household/contracts";
import { inject } from "vitest";
import { practicePorts, type PracticePorts } from "../../practice/fakes.ts";
import { accept, type Accepted } from "../coordinator/accept.ts";
import { databaseName, dropDatabases, ensureDatabase } from "../db/index.ts";
import { type Env, loadEnv } from "../env.ts";
import { launchJobs, stopJobs, waitForJob } from "../jobs/launch.ts";
import type { ShoppingHelper, Transcriber } from "../ports.ts";
import { createRuntime, type Runtime } from "../runtime.ts";

export type TestHousehold = {
  rt: Runtime;
  ports: PracticePorts;
  env: Env;
  /** Say something to the house as a person, the way the app adapter would. */
  say(text: string, opts?: { person?: string; channel?: Channel; ref?: string; action?: ActionKind; value?: string; dedupeKey?: string }): Promise<Accepted>;
  /** Tap a button. */
  tap(ref: string, action: ActionKind, opts?: { person?: string; value?: string; channel?: Channel }): Promise<Accepted>;
  /** Say it and wait for the job to finish. */
  sayAndWait(text: string, opts?: Parameters<TestHousehold["say"]>[1]): Promise<Accepted>;
  wait(accepted: Accepted): Promise<void>;
  close(): Promise<void>;
};

/**
 * QA-9 / FB-6: a fresh copy of the practice household (copied from a seeded template database per
 * domain), with practice ports and, optionally, DBOS jobs running.
 */
export async function testHousehold(options: { jobs?: boolean; start?: string; frozen?: boolean; ports?: { shopping?: ShoppingHelper; transcriber?: Transcriber }; env?: Record<string, string> } = {}): Promise<TestHousehold> {
  const url = inject("databaseUrl");
  const template = inject("templatePrefix");
  const prefix = `r${inject("runId")}${randomBytes(3).toString("hex")}`;
  for (const d of Object.values(Domain)) await ensureDatabase(url, databaseName(prefix, d), databaseName(template, d));
  const env = loadEnv({ DATABASE_URL: url, DB_PREFIX: prefix, ...options.env });
  const base = practicePorts({ frozen: options.frozen ?? true, ...(options.start === undefined ? {} : { start: options.start }) });
  const ports: PracticePorts = { ...base, ...options.ports };
  const rt = await createRuntime(env, ports);
  if (options.jobs ?? true) await launchJobs(rt);
  const say: TestHousehold["say"] = (text, opts = {}) => {
    const attachments: Attachment[] = [];
    if (opts.ref !== undefined) {
      const ref: Attachment = { kind: AttachmentKind.ref, ref: opts.ref };
      if (opts.action !== undefined) ref.action = opts.action;
      if (opts.value !== undefined) ref.value = opts.value;
      attachments.push(ref);
    }
    return accept(rt, {
      household: env.HOUSEHOLD_ID,
      person: opts.person ?? "priya",
      channel: opts.channel ?? Channels.app,
      text,
      attachments,
      dedupeKey: opts.dedupeKey ?? `test:${randomUUID()}`,
      receivedAt: ports.clock.now().toISOString(),
    });
  };
  const wait = async (a: Accepted) => {
    if (options.jobs ?? true) await waitForJob(a.jobId);
  };
  return {
    rt,
    ports,
    env,
    say,
    tap: (ref, action, opts = {}) => say(opts.value ?? action, { ...opts, ref, action }),
    sayAndWait: async (text, opts) => {
      const a = await say(text, opts);
      await wait(a);
      return a;
    },
    wait,
    close: async () => {
      if (options.jobs ?? true) await stopJobs();
      await rt.close();
      await dropDatabases(url, prefix);
    },
  };
}

/** Poll until a condition holds (test helper; DBOS recovery and child workflows take a moment). */
export async function eventually(check: () => boolean | Promise<boolean>, tries = 150): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("condition never held");
}
