---
name: wlib
description: "CRITICAL: Load when needing shared functionality or touching the wlib submodule. Missing this = duplicated helpers and broken builds. Covers what wlib provides, import rules, and submodule upkeep."
---

## When to use me
- When you need scroll, keys, theme, logging, clipboard, reload guards, dialogs, or system snapshots, or export serializers / the export overlay
- When importing from `model-usage/wlib/`
- When bumping the submodule or syncing the deployed copy

## Not intended for
- Where code lives overall → use `architecture`
- Plugin entry points → use `plugin-development`

---

## Host adapters (v1 / v2) — MUST

wlib talks to the host through a single `WlibHost` contract
(`wlib/src/host/types.ts`); command/keymap, dialog, theme and renderer helpers
take a `WlibHost`, never a raw plugin API.

| Generation | Factory | Import | Status |
|---|---|---|---|
| v2 | `createV2Host(context)` | `model-usage/wlib/src/host/v2` | **Supported (production)** |
| v1 | `createV1Host(api)` | `model-usage/wlib/src/host/v1` | **Deprecated** — transition only |

**Policy:** create exactly one host per entrypoint and never mix v1 and v2 in
one runtime adapter.

## What wlib provides (`model-usage/wlib/src/`)

All modules live under `src/core` (pure/host-agnostic) or `src/ui` (SolidJS).

| Module | Provides |
|--------|----------|
| `core/system` | `writeSystemSnapshot` / `readSystemSnapshot` (final system sidecar), `isTitleGenerator`, `estimateTokens` |
| `core/scroll` | `makeScrollState` (up/down/page, overflow tracking) |
| `core/keys` | `registerDialogKeyLayer(host, config)` |
| `core/theme` | `resolveThemeColors` (v1/loose), `resolveSemanticTheme` (v2 semantic tokens) |
| `core/log` | `createLog` (debug-gated file logging) |
| `core/reload` | `createLoadGuard` (stale-fetch guard) |
| `core/clipboard` | `writeClipboard` (+ candidate resolution, OSC 52) |
| `core/command` | `registerSlashCommand(host, opts)` |
| `core/dialog-fit` | `resolveDialogFit` (pure sizing math) |
| `ui/dialog` | `useDialogSizing(host, desired)`, `DialogShell` |
| `core/export` | `ExportFormat`, `ExportFormatOption`, `EXPORT_FORMATS`, `Exportable` (the generic export contract) |
| `ui/export-controller` | `createExportController(host, exportable, opts)` (owns the export flow) |
| `ui/export-overlay`, `ui/export-result-overlay` | presentational export popups |
| `ui/help-overlay` | `HelpOverlay` popup |
| `ui/copied-flash` | `CopiedFlash` (presentational `hint` ↔ `copied!` toggler) |

## Export foundation (reference)

The `export` module is the generic export CONTRACT, not any feature's serializers:
- `Exportable { formats: ExportFormatOption[]; build(format: ExportFormat): string }` — the interface each feature implements.
- `createExportController(host, exportable, opts)` — the reusable controller that owns overlay state, key handling, the temporary `priority: 2` key layer, clipboard/file writes, and the `copied!` flash (`copiedFlash()` signal + `onCopied(listener)` event).
- `EXPORT_FORMATS` — the canonical four formats (Markdown/CSV/JSON/plain text).

Feature-specific serializers (usage, analyze, …) live in the consuming plugin, not here — e.g. `opencode-model-usage/model-usage/helpers/export/usage.ts`.

## Import rules (MUST)

- Import directly: `import { x } from "./wlib/src/core/<module>"` (or `src/ui/...`) — never `export { x } from "./wlib/..."`. The plugin runtime transpiler **drops re-exports** and the names end up undefined.
- Never create a sibling file with the same base name (`.ts` vs `.tsx`) — host resolution may pick the wrong one.
- For theme colors: values are `ThemeColorValue` (`string | RGBA`) — pass objects through, never string-coerce.

## Submodule upkeep

- Current pin: `34cae7a71f118ee148a65a2e66099997ed0483c5` (canonical v2 commit — `WlibHost` + `src/host/{v1,v2}`; defaults v2 keymap layers to global mode).
- Bump: `git submodule update --remote --merge` at repo root, then commit the pointer change.
- The canonical branch is `origin/v2` (the pin tracks it). If the submodule working tree is dirty and the merge refuses: `git -C model-usage/wlib fetch origin && git -C model-usage/wlib reset --hard origin/v2` (only after confirming no local work).
- Keep the deployed copy in sync via the `deploy` skill — it mirrors `model-usage/` (which includes `wlib/`).
- wlib source lives in the `opencode-wlib` repo — never edit its files only inside the submodule; upstream changes there first.

## Blockers (MUST NOT)

- Duplicating wlib functionality locally (scroll/keys/theme/log/reload/clipboard/dialog/system/export/export-overlay) — the old `shared/` folder is gone for a reason
- Mixing `createV1Host` and `createV2Host` in one runtime adapter
- Re-export patterns from wlib modules
- Committing a submodule bump without the deployed copy in sync

## References
- `architecture` — the no-duplication rule
- `plugin-development` — dialogs and server wiring use these helpers
- https://github.com/Wikijito7/opencode-wlib — the source repo
