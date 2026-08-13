---
name: quality-check
description: "CRITICAL: Load before reporting a task done or opening a PR in this repo. Missing this = failing gates and rejected PRs. Runs the repo's test suite and typecheck and reports pass/fail."
---

## When to use me
- At the end of a task in this repo, before reporting completion
- Before opening a PR or requesting review on `opencode-model-usage`
- After a rebase/merge to validate the local state

## Not intended for
- Code review (quality of the implementation) → use `code-review`
- Other repos → each repo has its own per-repo `quality-check` (see `bootstrapper`)

---

## Quality Gates (MUST)

| Order | Gate | Command | Status |
|-------|------|---------|--------|
| 1 | Tests | `bun test` | Must pass |
| 2 | Typecheck (best-effort) | `bunx tsc --noEmit` | If available |

This repo has **no package.json and no lint config** — lint is not a gate here (skip it, don't invent commands).

## Step 1 — Tests (the real gate)

```bash
bun test
```

- Runs the full suite from the repo root: model-usage tests **plus** the `model-usage/wlib` submodule tests.
- All suites must pass: `{N} pass, 0 fail`.
- **Never report done or open a PR with failing tests.**

## Step 2 — Typecheck (best-effort)

```bash
bunx tsc --noEmit
```

- The host-only deps (`@opentui/solid`, `@opencode-ai/plugin/tui`) aren't resolvable in isolation, so tsc may report unrelated errors or fail to resolve.
- If tsc isn't available or errors on host deps, note it as skipped — don't chase host-resolution noise.
- If tsc runs clean, even better — report it.

## Step 3 — Sanity (quick)

```bash
git status --short
```

- No stray files, no secrets, nothing unexpected staged.
- If deployed copies exist (`~/.config/opencode/plugins/model-usage/`), they should be in sync with the repo — flag drift.

## Reporting

```
QUALITY CHECK: {PASS | FAIL}
- Tests: {pass | fail} ({N} passed / {M} failed)
- Typecheck: {pass | fail | skipped} (reason if skipped)
- Notes: {anything skipped, pre-existing failures, sync drift}
```

- **BLOCKER**: failing tests → report `FAIL`, do NOT mark the task done.
- **WARNING**: typecheck skipped, pre-existing failures unrelated to the change.
- **PASS**: tests green.

## References
- `code-review` — deeper implementation-quality review (run after gates pass)
- `bootstrapper` — generates per-repo quality-check skills for other repos
