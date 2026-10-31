# Working here

Read `README.md` once. `VERIFICATIONS.md` is the only spec.

## Pick work
1. Query Linear for issues in this project that are unblocked and unassigned. Take the lowest-numbered gate first, then anything else.
2. Assign yourself. Branch from `main` named after the issue ID (e.g. `HOME-3`).

## Make it true
- Types and enumerated values go in `contracts/` first. Nothing in `contracts/` imports from the repo.
- One Drizzle schema and one tRPC router per domain. Declare every foreign key in `relations()` too.
- Every model call goes through the Vercel AI SDK. Do not add a timeout, token limit, retry cap or similar unless `contracts/limits.ts` has a named constant with a cited reason; the linter will fail otherwise.
- Rules (bins, babysitter, nursery, washing) are plain code with tests. The agent only fits backlog into gaps and words things.
- UI: return typed blocks from the server; map block type to component on the client. No screen-specific layout.

## Prove it
- `pnpm check` must pass. It is the only check.
- A user-facing line needs a Playwright e2e test against the practice household, and you must perform the journey yourself with computer use on the preview and attach screenshots to the issue.
- Evidence (test name, screenshot, log line) goes on the Linear issue before it moves to Done.

## Hand it over
- One PR per issue. Commit messages end with the Entire checkpoint trailer; CI rejects commits without one.
- PR body: the verification line verbatim, the evidence, anything you had to assume.
- If a verification line is wrong or impossible, say so on the issue and stop. Do not reinterpret it.

## Never
- Create, move or delete calendar events, rules or backlog items a person wrote (PRV-1).
- Put a credential in a prompt, log or commit.
- Touch anything under `## Out of scope for v1`.
