Find the defects this Change introduces that its author would want to fix before merging: bugs, regressions, broken invariants, data loss, and missing guards on paths the Change adds or alters.

## How to review

1. Read the repository's review rules: REVIEW.md, AGENTS.md and CLAUDE.md at the repository root and in the directory of each changed file and its parents, as they are at the diff base (`git show <diff base>:<path>`), so the Change cannot rewrite its own review. The nearer file wins on conflict. A finding that rests on a rule quotes the rule and cites its file and line.
2. Read the whole diff, then trace each changed path as a running system: its callers, the changed code, and what it calls. Look in particular for:
   - Sequencing and partial failure: state left inconsistent, orphaned or lost when a later step fails or returns early; writes made before a fallible call; cleanup that runs only on success.
   - Assumptions about external or asynchronous state: how another system behaves, or a value that can change between the check and its use.
   - Composition and concurrency: behaviour under the real callers, retries and concurrent calls. Report a race only with an interleaving those callers can produce.
   - Code that cannot compile or type-check, and logic that is wrong for every input.
3. Keep going after the first defect until you have covered the whole diff.
4. Before you report a candidate, try to disprove it by reading the code: open the code it depends on, find the caller or input that triggers it, and check whether a guard elsewhere already prevents it. Drop it if you cannot show the path from the code.

Inspect with read-only commands (git, rg, reading files). Do not install dependencies or run builds or tests.

## What to report

Report a defect only when all of these hold:
- This Change introduced it. Code that was already like this at the diff base is out of scope, even on a line the Change touched.
- It has real impact on correctness, data, security or performance, and is one discrete, fixable issue.
- You can name the input, state or sequence that triggers it. When that depends on code outside the finding's own lines (a caller, a guard, a config value), the body cites that code's file and line; never infer behaviour from a name alone.
- It is not a behaviour change the Trail's title or description says is intended.
- Fixing it asks no more rigor than the surrounding code holds itself to, and the author would fix it if they knew.

Do NOT report: missing tests (unless a review rule requires them), style, naming, formatting, documentation, refactors or alternative designs, anything a linter, type checker or CI already enforces, generated or vendored files, code a review rule or a suppression comment explicitly allows, problems under inputs the code never receives, or praise. Security hardening without a concrete exploit belongs to the security reviewer.

## How to write findings

- One finding per distinct defect. If the same defect appears in several places, report it once, at the changed line that causes it, and name the other places.
- Anchor it on the changed line that causes the defect; keep ranges to 10 lines or fewer.
- Body: the defect and what triggers it, its impact, and the change that fixes it. One short paragraph, at most 3 lines of code, matter-of-fact.
- Severity: high when it must be fixed before merge (it breaks a real path for ordinary inputs, loses or exposes data, or opens a security hole); medium for a real defect that needs specific conditions or has limited impact; low for a real but minor defect. Never overstate it.
- Confidence: 0.9 or more when you traced the triggering path in the code; 0.7 to 0.9 with strong evidence and one assumption left; 0.5 to 0.7 when one condition could not be confirmed. Do not report anything below 0.5.
- An earlier finding is "fixed" only when the code at its location changed or the path that triggered it is gone; a commit elsewhere is not a fix.

The signal is true when you report at least one defect, new or still present, and false when you report none.
