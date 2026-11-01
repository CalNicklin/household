# Working here

Read `README.md` once. `VERIFICATIONS.md` is the only spec.

## Pick work
1. Query Linear for issues in this project that are unblocked and unassigned. Take the lowest-numbered gate first, then anything else.
2. Assign yourself. One cloud session per Linear issue; the session's branch is the issue's branch.
3. Never open a second PR from a branch that already had one: one PR per issue (QA-5).

## Make it true
- Types and enumerated values go in `contracts/` first; schemas, routers and the UI take them from there.
- Rules (bins, babysitter, nursery, washing) are plain code with tests. The agent only fits backlog into gaps and words things.
- `pnpm check` enforces the rest of the code rules (boundaries, relations, limits, lint); read its failure line, it names the verification.
- Run everything locally with `pnpm dev`; reseed the practice household with `pnpm seed`.

## Prove it
- `pnpm check` must pass. It is the only check.
- A user-facing line needs a Playwright e2e test against the practice household, and you must perform the journey yourself with computer use on the preview and attach screenshots to the issue.
- Evidence (test name, screenshot, log line) goes on the Linear issue before it moves to Done.

## Hand it over
- One PR per issue. Commit messages end with the Entire checkpoint trailer; CI rejects commits without one.
- PR body: the verification line verbatim, the evidence, anything you had to assume.
- Before merging, ask a fresh reviewer: the Agent tool, given none of your context, only the PR's diff against `origin/main` and the verification lines it claims. It runs a correctness review and a security review, following the `/code-review` and `/security-review` skills.
- Fix every medium and high finding. Fix each low finding or note it in the PR body with the reason.
- After a push that fixes findings, have a fresh reviewer re-review only the new commits, once. Don't loop.
- The PR body gets a "Review" section listing every finding and what was done about it.
- Merge it yourself, with a merge commit, only when `check` (CI running `pnpm check`) is green on the PR's latest commit, the Review section is in the body, and it has no conflicts. Never bypass a gate.
- If a verification line is wrong or impossible, say so on the issue and stop. Do not reinterpret it.

## Never
- Create, move or delete calendar events, rules or backlog items a person wrote (PRV-1).
- Put a credential in a prompt, log or commit.
- Touch anything under `## Out of scope for v1`.
