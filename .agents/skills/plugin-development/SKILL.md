---
name: plugin-development
description: "CRITICAL: Load when touching entry points, hooks, commands, or dialogs in this repo. Missing this = silent hook failures and broken dialogs. Covers server/TUI wiring, dialog sizing, and deployment."
---

## When to use me
- When modifying `model-usage/server.ts` / `model-usage/tui.tsx` (v2) or the deprecated v1 `model-usage-server.ts` / `model-usage.tsx`
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
| `model-usage/server.ts` | v2 server: `Plugin.define({ id, setup })` → `session.hook("context")` (system parts + tool defs) | v2 |
| `model-usage/tui.tsx` | v2 TUI: `Plugin.define({ id, setup })` → `createV2Host`, `ui.slot("sidebar.content")`, `registerSlashCommand` | v2 |
| `model-usage/v2/analyze.tsx` | v2 Analyze dialog + tabbed breakdown + raw visor (`v`) | v2 |
| `model-usage/v2/usage.tsx` | v2 Usage dialog (month/week/day views) | v2 |
| `model-usage/v2/sidebar.tsx` | v2 sidebar slot (cost + quota indicators) | v2 |
| `model-usage-server.ts` | v1 server: `experimental.chat.system.transform` + `tool.definition` | v1 (deprecated) |
| `model-usage.tsx` | v1 entry: `registerSlashCommand` via `createV1Host` | v1 (deprecated) |
| `model-usage/analyze.tsx`, `usage.tsx`, `sidebar.tsx` | v1 dialogs/sidebar | v1 (deprecated) |

Deployment selection: the v2 plugin directory is `model-usage/` (Host resolves `server`/`tui`); the v1 entrypoints are loose files. See the `deploy` skill. Never move the v2 entrypoints or the v1 loose files into each other's layout.

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
