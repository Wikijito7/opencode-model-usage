---
name: testing
description: "IMPORTANT: Load when writing or modifying tests in this repo. Missing this = tests that don't follow conventions or don't run. Covers bun:test patterns, aliases, and suite layout."
---

## When to use me
- When writing a new test file or test case
- When modifying behavior in `helpers/*`, `*-domain.ts`, `db.ts`, or `cache.ts`
- When a test needs to touch the filesystem, sqlite, or fake DOM-like elements

## Not intended for
- Choosing where code lives → use `architecture`
- Running the gates at the end → use `quality-check`

---

## Running tests

```bash
bun test
```

- Run from the repo root — the suite includes `model-usage/wlib/` submodule tests.
- All suites must pass before reporting done (`{N} pass, 0 fail`).

## Test file layout

| Code under test | Test location |
|-----------------|---------------|
| `model-usage/helpers/*.ts` | `tests/model-usage/helpers/*.test.ts` |
| `model-usage/analyze-domain.ts` | `tests/model-usage/analyze-domain.test.ts` |
| `model-usage/helpers/fragments.ts` | `tests/model-usage/analyze.test.ts` |
| `model-usage/db.ts` / `cache.ts` | `tests/model-usage/db.test.ts` / `cache.test.ts` |
| wlib modules | inside `model-usage/wlib/` (own test files) |

## Conventions

- Use `describe` / `it` / `expect` from `bun:test`.
- Import via the `@model-usage/*` alias (e.g. `@model-usage/helpers/format`), configured in `tests/tsconfig.json`.
- Test **pure functions only** — helpers and domain modules are designed for this (no TUI imports). If a module can't be tested purely, it belongs in `architecture`'s crosshairs, not in a workaround.
- **Filesystem**: use `mkdtempSync` + cleanup in `finally` — never write to repo paths.
- **Scroll-like elements**: fake the element (`scrollBy`, `scrollHeight`, `clientHeight`, `scrollTop`) instead of importing DOM.
- **Fragments tests**: cover the persona boundaries — 2 blank lines, 1 blank line + marker/preamble, and 0 blank lines (preamble terminates the section). Keep the legacy `jungle-mode/` marker tests.
- **Domain tests**: reuse the `makeUserMessage` / `makeAssistantMessage` helpers from `analyze-domain.test.ts` for message streams.

## Reporting

```
Tests: {N} passed / {M} failed
```

Failed tests are a BLOCKER — never report done or open a PR with red tests.

## References
- `architecture` — where pure modules live
- `quality-check` — the full gate sequence
