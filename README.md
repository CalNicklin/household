# Household

A coordinator for one family's life admin. It owns the remembering so neither parent has to: it reads the shared calendar, a brain-dump backlog, the weather, daylight, parcels and a few household rules, and composes a morning screen for the kitchen iPad plus a handful of well-timed messages. On a hard day it makes the day smaller. It can only suggest; it never moves, deletes or spends.

The product is the morning glance and the "what now?" answer. Everything else is an input to that.

## Who it is for

Two adults and two small children in one house. There is no multi-tenant story and no public launch. Chloe is the primary user of the morning screen and messages; Cal is the primary user of the MCP channel and the code.

## What done means

`VERIFICATIONS.md` is the specification. Every line is a statement that will be true when the build is finished, with an ID that becomes one Linear issue. Lines marked **(gate)** block the rest of their section. The job is to make every line true, prove it, and attach evidence. There is no other backlog.

The sections headed "Cal only" (Channels, Platform, Quality and dev workflow, Code, Feedback loop) are the engineering constraints. The rest describe user-visible behaviour and were written to be read by both of us.

## Decisions already made

These are settled. Do not relitigate them in code; raise a question on the Linear issue if one is wrong.

- **Architecture**: ingress adapters → coordinator → job (DBOS workflow) → one Mastra agent → tools. Time is an ingress like any other. Nothing else can invoke the agent.
- **UI**: a PWA built with TanStack Start. The home screen is server-driven: the planner returns an ordered list of typed blocks (`context`, `mode`, `event`, `suggestion`, `alert`, `arrival`, `backlog-pick`, `composer`) with a reason per block; the client maps block type to component and owns no layout logic. Nav is secondary.
- **State**: Postgres, one database per domain, Drizzle + drizzle-kit, relations declared in both the table and `relations()`. No Postgres enums; enumerated values are `as const` objects in the root `contracts` package, which nothing else may import from. Domains talk only through their tRPC router.
- **Durability**: DBOS workflows for every job, child workflows for long tool calls, DBOS scheduled workflows for timers. No hand-written queue.
- **Memory**: structured household facts live in Postgres and are readable without a model call. Episodic memory (phrasing, dismissals) lives in Hindsight.
- **Models**: every call goes through the Vercel AI SDK; provider is configuration. No timeout, token, retry or concurrency limit anywhere without a cited reason in `contracts/limits.ts` (see CODE-13 to CODE-15).
- **Artifacts**: S3-compatible object storage we run, referenced by key from Postgres.
- **Rules vs agent**: babysitter, bins, nursery and washing nudges are deterministic code with tests. The agent is consulted only for fitting backlog items into gaps and for wording.
- **Quality gates**: `pnpm check` runs tsc (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), oxlint, Fallow (`fallow audit`, with architecture boundaries encoding the contracts-first direction and one-database-per-domain), drizzle-kit check and tests. It is the only command CI runs.
- **Git**: Entire is enabled; every commit carries an `Entire-Checkpoint` trailer. One PR per Linear issue, branch named after the issue ID.
- **Hosting**: our own server, one `docker compose up`.

## Design

Screens for the home (normal and slow-day), phone, backlog, and the block vocabulary live on the design canvas and are being rebuilt in Paper from a shared token set. The building agent reads Paper through its MCP server for real HTML/CSS rather than redrawing from screenshots (QA-3). Until the Paper frames exist, the canvas is the reference. Design intent: calm, uncluttered, big type for glanceability; green means a planner suggestion, amber means a rule-derived alert; every planner-made item has a no-guilt dismiss.

## Things only a human can provide

Google OAuth for the shared calendar, WhatsApp or Telegram credentials, the supermarket login (goes in the vault, never in a prompt), the server, and Chloe's sign-off on the Learning and Wellbeing sections. Stub these behind the practice household (QA-9) and keep going; do not block on them.

## Out of scope for v1

See the last section of `VERIFICATIONS.md`.
