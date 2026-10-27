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

- **Current pin: `a84759066ee6071f5c312d4cfcc543091f5141c3` (short `a847590`)** —
  "Added OpenCode 2.0 host adapters (#6)": the merged wlib `main` commit. It
  carries the v1/v2 `WlibHost` adapters and the success/warning theme support:
  optional `success`/`warning` on the base `ThemePalette`, narrowed to required
  (with `selectedText`) on `SemanticThemePalette`, plus
  `ThemePaletteFallbacks.success`/`.warning` and
  `THEME_DEFAULTS.success`/`.warning` (`#22c55e` / `#eab308`), and maps
  `text.feedback.success.base` / `text.feedback.warning.base` in the v2 resolver
  (v1 reads `theme.success` / `theme.warning`).
- **Publish status:** `a847590` is **published on `opencode-wlib` `main`** (it is
  the current `origin/main` tip), so any clone can fetch it. Verify the remote
  before bumping with `git -C model-usage/wlib fetch origin` and
  `git -C model-usage/wlib rev-parse origin/main`.
- **Chosen source branch:** this project pins the merged `main` lineage; future
  maintenance follows the project's chosen v2 source branch (`origin/main` unless
  the project deliberately retargets it). Never `git reset --hard` and never force.
- Bump (safe): at repo root run
  `git -C model-usage/wlib fetch origin`, then pin the exact commit with
  `git -C model-usage/wlib checkout <commit-sha>` (or
  `git -C model-usage/wlib merge --ff-only origin/main` when advancing to the
  tip), and commit the gitlink change in the parent repo. Do **not** use bare
  `git submodule update --remote`: `.gitmodules` sets no `branch`, so `--remote`
  follows the submodule's remote HEAD and can move off the vetted pin
  unpredictably. Confirm with `git submodule status` that the sole change is the
  gitlink.
- If the submodule working tree is dirty and the operation refuses:
  1. **Inspect first:** `git -C model-usage/wlib status` to see exactly what is modified/untracked.
  2. **Preserve the work — never discard it:** commit it on the submodule branch, or `git -C model-usage/wlib stash push -u -m wlib-pre-bump`.
  3. **Recover to the parent gitlink:** `git submodule update --init --force model-usage/wlib` (checks out the commit the parent repo pins) — confirm with `git submodule status` before assuming the pin is intact.
  4. **Advance only when clean:** `git -C model-usage/wlib fetch origin` then checkout the intended commit (or `merge --ff-only` the chosen source branch), and restore any stash with `git -C model-usage/wlib stash pop`.
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
