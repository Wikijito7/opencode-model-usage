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

## Theme palette (from `wlib/src/core/theme.ts` `resolveThemeColors` / `resolveSemanticTheme`)

- Keys: `fg`, `muted`, `red`, `primary`, `success`, `warning`, `selectedText` (may be `undefined`), `background`, `panel`.
- `success` / `warning` are semantic feedback tokens: optional on the loose `ThemePalette` (source-compat) and **required** on the v2 `SemanticThemePalette`. Both resolvers populate them at runtime; they map from `text.feedback.success.base` / `text.feedback.warning.base`, falling back to `#22c55e` / `#eab308`.
- There is NO `border`, `secondary`, `highlight`, or `bg` key.
- Values are `ThemeColorValue` (`string | RGBA`) — pass through as-is, never string-coerce.

## Quota status colors (v2 sidebar, settled)

- Use semantic tokens, not hardcoded hex: `success` for healthy usage (≤75%), `warning` for >75% through 90%, `red` for >90%. The comparisons are strict `>`, matching v1 `helpers/format.ts:getUsageColor`.
- Projection line: `success` while projected usage stays ≤100%, `red` above 100%.
- `Unlimited` uses `success`; `No token provided` uses `warning`.
- Loading, missing data, and fetch errors stay `muted` (neutral), never a status color.

## v2 semantic theme resolution (settled)

- On v2 `host.theme()` wraps `resolveSemanticTheme(context.theme)`, where `context.theme` is a **`ResolvedTheme`**: action states are `focused` / `selected` / `base` (no `$` sigil). The raw theme JSON a plugin authors uses `$focused` / `$selected`; those spellings never appear in the resolved context.
- The selection background (`primary`) resolves **`focused` first**, so the filled chip paints with the focused accent; a transparent `selectedText` falls through to the resting text color. The exact focused→selected→base order, the transparent-value skip, and the RGBA-identity rule are in `wlib`.

## Selection / highlight convention (settled)

- The active/selected item is a filled "chip": `backgroundColor={primary}` on the row `<box>`, label `<text fg={selectedText}>` (falls back to the default color when `selectedText` is `undefined`).
- Inactive items: `fg={muted}`, no background.
- NO `>` cursor marker, NO `bold`. This matches the analyze dialog tab bar.
- **Explicit exception — Usage Sessions list is TEXT-ONLY (settled):** the `/usage` Sessions view does NOT use a chip. The selected row is a text-only title in `primary` (`<text fg={selected ? primary : fg}>`), the inactive title is `fg`, the stats line is always `muted`, and the row `<box>` carries NO `backgroundColor` and NO horizontal padding (`<box flexDirection="column" gap={0}>`, preserving `data-session-idx` + scroll). This mirrors shipped v1 exactly. The filled chip applies to Analyze tabs and Persona rows only.

## Dialog sizing (settled)

- `DialogSize` tiers: `medium` (60) / `large` (88) / `xlarge` (116) via `wlib/dialog-fit.ts` + `useDialogSizing`.
- `opencode-model-usage` dialogs use `large`; `opencode-persona-injector` uses `medium`.

## Root dialog box (convention)

- `paddingLeft={2} paddingRight={2} paddingBottom={1} flexDirection="column" gap={1}` (via `DialogShell` or inlined identically).

## Export overlay (`wlib/export-overlay.tsx`) — settled

- Opened by the `e` key in `/usage`. It is a small popup, SMALLER than the help overlay.
- Layout: centered medium-width modal. Outer box = `position="absolute" zIndex={10} left/top/right/bottom=0` + `alignItems="center"` + `justifyContent="center"` + dimmed backdrop `backgroundColor={RGBA.fromInts(0, 0, 0, 150)}`. Inner box = `width={DIALOG_WIDTHS.medium}` (60), NO height/top/bottom/flexGrow (wraps content), `backgroundColor={panel}`, NO border.
- Format options are FLUSH (wrapped in a gap-less `<box flexDirection="column">`, each option `paddingLeft={1} paddingRight={1}`, no vertical padding) — matching the persona-injector dialog's list spacing.
- **Flow is three steps: format → destination → result.** `enter` on a format advances to the destination list (`Export to`: Clipboard / File); `esc` goes back one step. Clipboard → `writeClipboard()` + close; File → `writeFile()` then the **result popup** (`ExportResultOverlay`).
- **Result step (settled):** on success the popup shows the saved path and two chips — `← →` move focus between `Close` (left) and `Open` (right), `enter` activates the focused chip (`Open` runs `openFolder`, `Close` dismisses), and `o` opens the folder immediately (`openFolder`) as a shortcut. On a **file-write error** the popup shows the error, `Open` is unreachable (only `Close` remains), `enter`/`esc` close it, and the other registered dialog/export keys are consumed so `Open` cannot fire (the result step is modal). The keymap only invokes handlers for registered bindings, so truly unbound keys are never dispatched.
- `esc` closes the overlay ONLY (not the whole dialog), except inside the result step where it closes the whole export flow; `e` toggles.
- **State is owned by the wlib `createExportController`, not the parent dialog.** The controller owns `step`/`showExport`/`showResult` plus the temporary `priority: 2` key layer (never add `enter` to the help `usageBindings`). Because the dialog's render callback may re-run, allocate the controller **once per dialog** in a `createOwnedInstance` wrapper constructed outside the callback; call the lazy `.get()` as the first operation inside the callback (so its standalone Solid root inherits the dialog's `Keymap.Provider`) and `dispose()` it in the dialog `onClose` (see `plugin-development` / `wlib`).
- Copy via `writeClipboard()` + a `copied!` flash (2s); the flash replaces the `e export` footer hint.
- The format→destination→result flow is **PTY-verified in the sandbox** (real terminal, clipboard + file writes) after the stable-owner fix.

## Popup backdrop convention

- Non-full-size popups (e.g. `ExportOverlay`) draw a semi-transparent black dim (`RGBA.fromInts(0, 0, 0, 150)`) behind the small box so it visually "pops" over the parent.
- Full-bleed overlays (e.g. `HelpOverlay`) instead use an opaque `panel` background and no dim.

## Usage dialog footer order (settled)

- `← → {gran}  ·  ↑↓ scroll  ·  e export  ·  h help` — `e export` BEFORE `h help`, and help is always LAST.
- During the flash: `← → {gran}  ·  ↑↓ scroll  ·  copied!  ·  h help`.
- **Usage navigation is arrow-only:** granularity/tab switching is `← →`; scroll/session selection is `↑↓` (no `h`/`l`/`j`/`k` aliases).
- The **Sessions** view is **text-only, NOT a filled chip** (explicit exception to the chip convention, matching shipped v1): the selected row's title is `fg={primary}` on an inactive `fg` title, the stats line is always `fg={muted}`, and the row `<box>` has no `backgroundColor` and no horizontal padding. `↑↓` move, `enter` opens `/analyze` for that session. The session view is toggled with `s`. (Filled chips remain for Analyze tabs and Persona rows.)

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