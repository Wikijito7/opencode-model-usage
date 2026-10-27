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

## Key layer mode (v2) — MUST

A v2 `KeymapLayer` that omits `mode` defaults to `base`. While a dialog is open
OpenCode 2.0.27 pushes mode `modal`, so a layer left at the host default is
inactive exactly when its dialog is visible. wlib's `toV2Layer` defaults
`mode` to `"global"` for both `registerDialogKeyLayer` and `registerCommand`;
keep that default (or set `mode` explicitly) — never emit a dialog layer at the
host default.

## What wlib provides (`model-usage/wlib/src/`)

All modules live under `src/core` (pure/host-agnostic) or `src/ui` (SolidJS).

| Module | Provides |
|--------|----------|
| `core/system` | `writeSystemSnapshot` / `readSystemSnapshot` (final system sidecar), `isTitleGenerator`, `estimateTokens` |
| `core/scroll` | `makeScrollState` (up/down/page, overflow tracking) |
| `core/keys` | `registerDialogKeyLayer(host, config)` — defaults the v2 layer `mode` to `"global"` |
| `core/theme` | `resolveThemeColors` (v1/loose), `resolveSemanticTheme` (v2 semantic tokens, incl. `success`/`warning` + `THEME_DEFAULTS`) |
| `core/log` | `createLog` (debug-gated file logging) |
| `core/reload` | `createLoadGuard` (stale-fetch guard) |
| `core/clipboard` | `writeClipboard` (+ candidate resolution, OSC 52) |
| `core/command` | `registerSlashCommand(host, opts)` |
| `core/dialog-fit` | `resolveDialogFit` (pure sizing math) |
| `ui/dialog` | `useDialogSizing(host, desired)`, `DialogShell` |
| `core/instance` | `createInstanceSlot(factory, dispose?)` (pure create-once / dispose-once bookkeeping) |
| `ui/owned-instance` | `createOwnedInstance(factory)` (stable Solid owner for dialog-scoped state; lazy `get()`, idempotent `dispose()`) |
| `core/export` | `ExportFormat`, `ExportFormatOption`, `EXPORT_FORMATS`, `Exportable` (the generic export contract) |
| `ui/export-controller` | `createExportController(host, exportable, opts)` (owns the format→destination→result flow) |
| `ui/export-overlay`, `ui/export-result-overlay` | presentational export popups |
| `ui/help-overlay` | `HelpOverlay` popup |
| `ui/copied-flash` | `CopiedFlash` (presentational `hint` ↔ `copied!` toggler) |

## Theme resolution (v2) — reference

`host.theme()` calls `resolveSemanticTheme(context.theme)`. `context.theme` is a
`ResolvedTheme`, so action states are `focused` / `selected` / `base` — the
`$focused`/`$selected` spelling exists only in the raw theme JSON a plugin
authors, never in the resolved context. `primary` resolves
`background.action.primary.focused` → `.selected` → `.base`; `selectedText`
resolves `text.action.primary.focused` → `.selected` → `.base`. Transparent
values (`"transparent"` or zero-alpha RGBA) are treated as absent and skipped
(the default theme paints only `focused`); non-transparent RGBA objects are passed
through by identity.

`SemanticThemePalette` narrows **three** fields to required, always-defined
values: `selectedText`, `success` and `warning`.

- `success` / `warning` (semantic status colors) resolve from
  `text.feedback.success.base` / `text.feedback.warning.base` with the same
  visible-color validation as the rest of v2: a transparent/zero-alpha token is
  skipped and a non-transparent `RGBA` is passed through by identity (never
  string-coerced), falling back to `THEME_DEFAULTS.success = "#22c55e"` /
  `THEME_DEFAULTS.warning = "#eab308"`.
- On the base `ThemePalette` they are **optional properties** (source
  compatibility: existing `ThemePalette` literals and hand-written
  `WlibHost<ThemePalette>` implementations keep compiling). Both resolvers still
  populate them at runtime. When reading through the base type, use
  `palette.success ?? THEME_DEFAULTS.success`.
- The v1 loose resolver (`resolveThemeColors`) maps `theme.success` /
  `theme.warning`, then the caller's `ThemePaletteFallbacks`, then the same
  defaults. It does **not** read the nested `text.feedback.*` tokens.
- Base `selectedText` is a **required property whose value may be
  `ThemeColorValue | undefined`** (v1 can leave it undefined); only the v2
  `SemanticThemePalette` guarantees it is defined and visible.

Use `success`/`warning` for status text instead of abusing `primary`/`fg` — e.g.
quota health: `success` ≤75%, `warning` >75% through 90%, `red` >90% (strict
`>`, matching v1 `getUsageColor`). Read them from the v2 host (`host.theme()`),
not from the v1 `ThemePalette` surface.

## Export foundation (reference)

The `export` module is the generic export CONTRACT, not any feature's serializers:
- `Exportable { formats: ExportFormatOption[]; build(format: ExportFormat): string }` — the interface each feature implements.
- `createExportController(host, exportable, opts)` — the reusable controller that owns the **format → destination → result** state machine, key handling, the temporary `priority: 2` key layer, clipboard/file writes, and the `copied!` flash (`copiedFlash()` signal + `onCopied(listener)` event). Render `renderOverlay()` (format/destination popup) and `renderResultOverlay()` (file-save result) once in the dialog JSX; both return persistently mounted reactive `Show`s.
- `EXPORT_FORMATS` — the canonical four formats (Markdown/CSV/JSON/plain text).

**Ownership rule:** a controller registers a `createEffect` + `onCleanup` (key layer, flash timeout), so it needs a Solid owner that outlives the dialog's render-callback re-runs. Allocate it once per dialog with `createOwnedInstance(() => createExportController(...))`: construct the wrapper outside `host.dialog.show`, call `.get()` as the **first operation inside** the render callback (so its standalone `createRoot` inherits the dialog's `Keymap.Provider`), and `dispose()` in `onClose`. The full lifecycle rationale — including "this is not a blanket ban on component-scoped `onMount`/`onCleanup`" — is authoritative in `plugin-development`.

Feature-specific serializers (usage, analyze, …) live in the consuming plugin, not here — e.g. `opencode-model-usage/model-usage/helpers/export/usage.ts`.

## Import rules (MUST)

- Import directly: `import { x } from "./wlib/src/core/<module>"` (or `src/ui/...`) — never `export { x } from "./wlib/..."`. The plugin runtime transpiler **drops re-exports** and the names end up undefined.
- Never create a sibling file with the same base name (`.ts` vs `.tsx`) — host resolution may pick the wrong one.
- **Solid-dependent modules are `.tsx`:** OpenCode 2.0.27's local plugin loader applies the Solid/OpenTUI transform only to `.tsx`/`.jsx`, so a plugin-local module that returns JSX or uses Solid runtime APIs (`createRoot`, `createEffect`, signals) — and relies on that rewrite — must have a `.tsx` extension (e.g. `ui/owned-instance.tsx`, `ui/export-controller.tsx`). `core/*` stays `.ts` (pure, framework-free); a type-only `import type { JSX } from "solid-js"` is fine in `.ts`. This is loader-specific, not a universal requirement for every Solid runtime import in every environment.
- For theme colors: values are `ThemeColorValue` (`string | RGBA`) — pass objects through, never string-coerce.

## Submodule upkeep

- **Current pin: `ff473a1545dd4750e28c7ec008d3c6ed5d23802e` (short `ff473a1`)** —
  "Added success and warning semantic theme colors": adds optional
  `success`/`warning` to the base `ThemePalette`, narrows them (plus
  `selectedText`) to required on `SemanticThemePalette`, adds
  `ThemePaletteFallbacks.success`/`.warning` and
  `THEME_DEFAULTS.success`/`.warning` (`#22c55e` / `#eab308`), and maps
  `text.feedback.success.base` / `text.feedback.warning.base` in the v2 resolver
  (v1 reads `theme.success` / `theme.warning`).
- **Publish status (read before bumping):** the published remote is
  `opencode-wlib` branch `v2` at **`95167829c39cd4155bb250ff1801f0e25527f571`**
  (short `9516782`) — GitHub MCP verification, not a local tracking ref. Local
  `ff473a1` is **one commit ahead of that and unpublished**. Ignore the consumer
  submodule's `origin/v2` tracking ref: it is **stale at `5cab3e1`** and is not
  the actual remote state. The parent gitlink is also not yet committed at the
  new value: `HEAD` still records `9516782` while the submodule worktree is
  checked out at `ff473a1`, so that pointer change is a pending, uncommitted diff
  in `model-usage/wlib`. So `9516782` IS the published tip and another clone can
  fetch it; only `ff473a1` is unfetchable. Recovery step 3 below lands on
  `9516782` because of the uncommitted gitlink, not because the pin is unpublished.
- Bump: `git -C model-usage/wlib fetch origin && git -C model-usage/wlib merge origin/v2` at repo root, then commit the pointer change. Do **not** use bare `git submodule update --remote`: `.gitmodules` sets no `branch`, so `--remote` follows the submodule's remote HEAD (`origin/main`) — never the v2 pin.
- The canonical branch is `origin/v2` — the pin is meant to track it (currently
  one commit ahead of it, `ff473a1`, which is unpublished; `9516782` is published)
  — **never
  `origin/main`, and never any `reset --hard`**. If the submodule working tree is
  dirty and the merge refuses:
  1. **Inspect first:** `git -C model-usage/wlib status` to see exactly what is modified/untracked.
  2. **Preserve the work — never discard it:** commit it on the submodule branch, or `git -C model-usage/wlib stash push -u -m wlib-pre-v2`.
  3. **Recover to the parent gitlink:** `git submodule update --init --force model-usage/wlib` (checks out the commit the parent repo pins). With the current pending diff this lands on `9516782`, not `ff473a1` — confirm with `git submodule status` before assuming the pin is intact.
  4. **Advance only when clean:** `git -C model-usage/wlib fetch origin && git -C model-usage/wlib merge --ff-only origin/v2`, then restore any stash with `git -C model-usage/wlib stash pop`. This cannot reach `ff473a1` until it is published to `origin/v2`.
  Never run a destructive reset (`git reset --hard origin/main`, `origin/v2`, or bare) — it discards local work and can check out the wrong lineage.
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
