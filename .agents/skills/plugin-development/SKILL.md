---
name: plugin-development
description: "CRITICAL: Load when touching entry points, hooks, commands, or dialogs in this repo. Missing this = silent hook failures and broken dialogs. Covers server/TUI wiring, dialog sizing, and deployment."
---

## When to use me
- When modifying `model-usage-server.ts` (shared v1/v2 server entry), `model-usage/server-setup.ts` (v2 setup helper) / `model-usage/tui.tsx` (v2 TUI), or the deprecated v1 `model-usage.tsx`
- When adding or changing a command (`/analyze`, `/usage`), key binding, or dialog
- When changing how the system prompt or tool definitions are captured

## Not intended for
- Pure logic / helpers → use `architecture`
- Writing tests → use `testing`
- Deep plugin API mechanics → load the global `opencode-plugin` skill

---

## Entry points

| File | Role | Generation |
|------|------|-----------|
| `model-usage-server.ts` | **shared** server entry: default `{ id, server, setup }`. v2 reads `id`+`setup`; v1 reads `server`. | shared |
| `model-usage/server-setup.ts` | v2 server **setup helper**: plain `setup(context)` export, **no default** (imported by the root server file; not a directory entrypoint) | v2 |
| `model-usage/tui.tsx` | v2 TUI: `Plugin.define({ id, setup })` → `createV2Host`, `ui.slot("sidebar.content")`, `registerSlashCommand` — the `model-usage/` directory's only entry | v2 |
| `model-usage/v2/analyze.tsx` | v2 Analyze dialog + tabbed breakdown + raw visor (`v`) | v2 |
| `model-usage/v2/usage.tsx` | v2 Usage dialog (month/week/day views) | v2 |
| `model-usage/v2/sidebar.tsx` | v2 sidebar slot (cost + quota indicators) | v2 |
| `model-usage.tsx` | v1 TUI entry: `registerSlashCommand` via `createV1Host` | v1 (deprecated) |
| `model-usage/analyze.tsx`, `usage.tsx`, `sidebar.tsx` | v1 dialogs/sidebar | v1 (deprecated) |

Deployment selection: the shared root `model-usage-server.ts` is the server entry for **both** generations; the `model-usage/` directory is the v2 **TUI** entry only (Host resolves `tui`; there is deliberately **no package-root `server.ts`/`index.ts`**); the loose `model-usage.tsx` is the v1 TUI entry. See the `deploy` skill. Never move the v2 TUI entry or add a package-root server entry back into the directory.

Module extension: under OpenCode 2.0.27's local plugin loader, the Solid/OpenTUI transform is applied only to `.tsx`/`.jsx`, so any plugin-local module that returns JSX or uses Solid/OpenTUI runtime APIs (`createRoot`, `createEffect`, signals) and depends on that rewrite must be `.tsx` — the same code in a `.ts` file silently fails to transform. This is a property of this host's loader, not a blanket rule that every Solid runtime import in every environment requires `.tsx`. Pure `.ts` helpers and type-only imports stay `.ts`. See `architecture`.

## Server-side rules (MUST)

- **Title-gen skip**: on v2 title generation uses a separate `title` hook (structurally excluded), but keep the defensive `isTitleGenerator` guard so a tiny title system can never be captured.
- **Drift throttling**: keep the 32-token drift threshold + 5-min timestamp refresh pattern; don't write the file when nothing material changed.
- **System snapshots** are pre-injection by design. The final system comes from the wlib sidecar (`wlib/src/core/system`, written by persona-injector). Never reorder capture to "fix" ordering — rely on the sidecar.
- v2 `session.hook("context")` carries `event.tools` as `Record<name, { description, input }>`; rebuild `ToolDefSnapshot.rawText` from the complete effective tool set each call.
- v1 `tool.definition` accumulates per-session tool defs; rebuild `rawText` from ALL accumulated defs, not just the latest.

## Dialog rules (MUST)

- Register dialogs via `registerDialogKeyLayer(host, …)` + `useDialogSizing(host, …)` + `makeScrollState` from wlib — never hand-roll key layers or scroll state.
- Build the host adapter once (`createV2Host(context)` / `createV1Host(api)`) and pass it to every wlib helper — never call wlib with a raw host API.
- v2 dialogs: open with `host.dialog.show(render, onClose?)`, size with `host.dialog.set({ size })`, close with `host.dialog.clear()`.
- **Keymap `mode`**: a v2 `KeymapLayer` that omits `mode` defaults to `base`, and OpenCode 2.0.27 pushes `modal` while a dialog is open — so a `base` layer is inactive exactly when its dialog is visible. Leave it at `mode: "global"` for every plugin/dialog layer (wlib's `toV2Layer`/`registerCommand` default). Details: `wlib`.
- **Dialog render callbacks may re-run**: `host.dialog.show(render, onClose)` may re-evaluate `render` whenever a signal read in its body changes. This is not a ban on the callback itself — component lifecycle (`onMount`/`onCleanup`) and dialog-scoped registrations inside it are fine. The one rule: a stateful **long-lived controller** (e.g. `createExportController`) must be allocated **once per dialog**, never recreated on each render.
- **Owned instances for the long-lived controller**: hold it in a wlib `createOwnedInstance(factory)` constructed **outside** the callback. Call the lazy `.get()` as the **first operation inside** the render callback, so its standalone Solid root inherits the dialog's `Keymap.Provider` context (the controller's `createEffect` reads `context.keymap.layer`, which only exists inside the callback); later re-runs reuse the identical instance. `dispose()` it from the dialog `onClose` (covers escape/replacement/clear). See `wlib`.
- **Export result step is modal**: the wlib `createExportController` owns its keys — on success `← →` focus `Close`/`Open` (`enter` activates the focused chip, `o` opens the folder directly); on a file-write error only `Close` remains — `enter`/`esc` close and every other key is swallowed. Never add these keys to the help `usageBindings`; the controller's temporary `priority: 2` layer handles them.
- Sizing: pass the desired size/height (`useDialogSizing(host, { size, maxHeight })`) — it falls back to fit the terminal.
- Colors: for v2 use `host.theme()` (semantic tokens, RGBA pass-through); for v1 `host.theme()` wraps `resolveThemeColors`. Never string-coerce RGBA values.
- Small no-scrollbox dialogs (error states) may use `host.dialog.set({ size: "medium" })`.

## Deployment (verify after changes)

Sync to the live plugins folder using the `deploy` skill (cp entry points + rsync mirror with exclusions + runtime-artifact preservation). Do NOT use raw `cp -r` — it ships test files and can clobber `.usage-cache.json`.

- Restart opencode to load changes (plugins load at startup).
- Keep the deployed copy in sync with the repo — flag drift in the quality-check report.

## References
- `opencode-plugin` (global) — plugin API mechanics, hooks, loading order
- `opencode-dialogs` (global) — dialog UX patterns
- `wlib` — shared helpers used by every entry point
- `architecture` — where logic belongs
