---
name: wlib
description: "CRITICAL: Load when needing shared functionality or touching the wlib submodule. Missing this = duplicated helpers and broken builds. Covers what wlib provides, import rules, and submodule upkeep."
---

## When to use me
- When you need scroll, keys, theme, logging, clipboard, reload guards, dialogs, or system snapshots
- When importing from `model-usage/wlib/`
- When bumping the submodule or syncing the deployed copy

## Not intended for
- Where code lives overall → use `architecture`
- Plugin entry points → use `plugin-development`

---

## What wlib provides (`model-usage/wlib/`)

| Module | Provides |
|--------|----------|
| `system` | `writeSystemSnapshot` / `readSystemSnapshot` (final system sidecar), `isTitleGenerator`, `estimateTokens` |
| `scroll` | `makeScrollState` (up/down/page, overflow tracking) |
| `keys` | `registerDialogKeyLayer` |
| `theme` | `resolveThemeColors` (RGBA-aware palette) |
| `log` | `createLog` (debug-gated file logging) |
| `reload` | `createLoadGuard` (stale-fetch guard) |
| `clipboard` | `writeClipboard` (+ candidate resolution, OSC 52) |
| `command` | `registerSlashCommand` |
| `dialog` | `useDialogSizing`, `DialogShell` (entry is `dialog.tsx`; pure math in `dialog-fit.ts`) |

## Import rules (MUST)

- Import directly: `import { x } from "./wlib/<module>"` — never `export { x } from "./wlib/<module>"`. The plugin runtime transpiler **drops re-exports** and the names end up undefined.
- Never create a sibling file with the same base name (`.ts` vs `.tsx`) — host resolution may pick the wrong one.
- For theme colors: values are `ThemeColorValue` (`string | RGBA`) — pass objects through, never string-coerce.

## Submodule upkeep

- Bump: `git submodule update --remote --merge` at repo root, then commit the pointer change.
- If the submodule working tree is dirty and the merge refuses: `git -C model-usage/wlib fetch origin && git -C model-usage/wlib reset --hard origin/main` (only after confirming no local work).
- Keep the deployed copy in sync via the `deploy` skill — it mirrors `model-usage/` (which includes `wlib/`).
- wlib source lives in the `opencode-wlib` repo — never edit its files only inside the submodule; upstream changes there first.

## Blockers (MUST NOT)

- Duplicating wlib functionality locally (scroll/keys/theme/log/reload/clipboard/dialog/system) — the old `shared/` folder is gone for a reason
- Re-export patterns from wlib modules
- Committing a submodule bump without the deployed copy in sync

## References
- `architecture` — the no-duplication rule
- `plugin-development` — dialogs and server wiring use these helpers
- https://github.com/Wikijito7/opencode-wlib — the source repo
