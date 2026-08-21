---
name: design-system
description: "IMPORTANT: Load when building or reviewing dialog UI, overlays, or visual/interaction choices in this repo. Records settled visual and UX decisions so they are NOT re-litigated in QA/review. Missing this = endless re-flagging of already-decided UI choices."
---

## When to use me
- When building or modifying dialog UI (usage, analyze), overlays/popups, or selection/footer/tab styling
- When reviewing UI/UX changes (treat the settled decisions below as closed, not roasts)

## Not intended for
- Export data format/schema (CSV columns, JSON keys, rounding, escaping) → encoded in the plugin's `model-usage/helpers/export/usage.ts` + its tests
- Module boundaries and layering → use `architecture`
- Test writing → use `testing`
- Plugin entry points/hooks → use `plugin-development`

---

## Theme palette (from `wlib/theme.ts` `resolveThemeColors`)

- Keys: `fg`, `muted`, `red`, `primary`, `selectedText` (may be `undefined`), `background`, `panel`.
- There is NO `border`, `secondary`, `highlight`, or `bg` key.
- Values are `ThemeColorValue` (`string | RGBA`) — pass through as-is, never string-coerce.

## Selection / highlight convention (settled)

- The active/selected item is a filled "chip": `backgroundColor={primary}` on the row `<box>`, label `<text fg={selectedText}>` (falls back to the default color when `selectedText` is `undefined`).
- Inactive items: `fg={muted}`, no background.
- NO `>` cursor marker, NO `bold`. This matches the analyze dialog tab bar.

## Dialog sizing (settled)

- `DialogSize` tiers: `medium` (60) / `large` (88) / `xlarge` (116) via `wlib/dialog-fit.ts` + `useDialogSizing`.
- `opencode-model-usage` dialogs use `large`; `opencode-persona-injector` uses `medium`.

## Root dialog box (convention)

- `paddingLeft={2} paddingRight={2} paddingBottom={1} flexDirection="column" gap={1}` (via `DialogShell` or inlined identically).

## Export overlay (`wlib/export-overlay.tsx`) — settled

- Opened by the `e` key in `/usage`. It is a small popup, SMALLER than the help overlay.
- Layout: centered medium-width modal. Outer box = `position="absolute" zIndex={10} left/top/right/bottom=0` + `alignItems="center"` + `justifyContent="center"` + dimmed backdrop `backgroundColor={RGBA.fromInts(0, 0, 0, 150)}`. Inner box = `width={DIALOG_WIDTHS.medium}` (60), NO height/top/bottom/flexGrow (wraps content), `backgroundColor={panel}`, NO border.
- Format options are FLUSH (wrapped in a gap-less `<box flexDirection="column">`, each option `paddingLeft={1} paddingRight={1}`, no vertical padding) — matching the persona-injector dialog's list spacing.
- Interaction: `↑`/`↓` navigate, `enter` confirm (copy + close), `esc` closes the overlay ONLY (not the whole dialog), `e` toggles it.
- Parent dialog owns `selectedIndex`/`showExport` state; while open, a temporary `priority: 2` key layer binds `enter` (never add `enter` to the help `usageBindings`).
- Copy via `writeClipboard()` + a `copied!` flash (2s); the flash replaces the `e export` footer hint.

## Popup backdrop convention

- Non-full-size popups (e.g. `ExportOverlay`) draw a semi-transparent black dim (`RGBA.fromInts(0, 0, 0, 150)`) behind the small box so it visually "pops" over the parent.
- Full-bleed overlays (e.g. `HelpOverlay`) instead use an opaque `panel` background and no dim.

## Usage dialog footer order (settled)

- `← → {gran}  ·  ↑↓ scroll  ·  e export  ·  h help` — `e export` BEFORE `h help`, and help is always LAST.
- During the flash: `← → {gran}  ·  ↑↓ scroll  ·  copied!  ·  h help`.

## Analyze dialog footer / tab nav (settled)

- Tab navigation is **arrow-only** (`← →`): the `h`/`l` aliases were removed so `h` can open help without a key conflict. This is a deliberate, settled choice — do not re-add `h`/`l` tab aliases.
- Vertical scroll is **arrow-only** (`↑↓`), matching the usage dialog: the `j`/`k` aliases were removed. `PgUp`/`PgDn` remain bound and functional (registered commands `analyze.pageUp`/`analyze.pageDown`) but are **not** shown in the footer hint.
- Footer order: `← → tabs · ↑↓ scroll [· v raw · c copy/copied!] [· 1-5 expand] · r reload · e export · h help` — `e export` before `h help`, help LAST.
- The raw-copy flash uses the shared `CopiedFlash` component (`c copy` hint ↔ `copied!`), distinct from the exporter's flash (`e export` ↔ `copied!`).
- `h` opens the `HelpOverlay` (rows built from `buildHelpRows(analyzeBindings)`); `e` opens the `ExportOverlay` via `createExportController`.

## Shared design language (Wokis network)

- The selection chip, theme palette, root-box layout, and sizing tiers are shared across the network plugins (`opencode-model-usage`, `opencode-persona-injector`, …) via the `opencode-wlib` submodule.

## Repo-specific dialog differences (settled)

| Aspect | `opencode-model-usage` | `opencode-persona-injector` |
|--------|------------------------|-----------------------------|
| Dialog size | `large` (88) | `medium` (60) |
| Root box | inlined (not `DialogShell`) | `DialogShell` |
| Theme keys destructured | `fg, muted, red, panel, primary, selectedText` | `fg, muted, red, primary, selectedText` (no `panel`) |
| Nav keys | arrows (analyze tab nav is arrow-only `← →`; scroll arrow-only `↑↓` + `PgUp`/`PgDn`) | `↑↓/jk` |
| Footer (usage vs persona) | `← → {gran} · ↑↓ scroll · e export · h help` | `↑↓/jk navigate · enter select · esc close` |
| Overlays | `HelpOverlay` + `ExportOverlay` | none (single-list dialog) |

## References
- `architecture` — where code lives
- `wlib` — shared helpers (theme, dialog sizing, clipboard)
- `plugin-development` — dialog/key wiring