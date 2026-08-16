---
name: plugin-development
description: "CRITICAL: Load when touching entry points, hooks, commands, or dialogs in this repo. Missing this = silent hook failures and broken dialogs. Covers server/TUI wiring, dialog sizing, and deployment."
---

## When to use me
- When modifying `model-usage-server.ts` (server hooks) or `model-usage.tsx` (TUI entry)
- When adding or changing a command (`/analyze`, `/usage`), key binding, or dialog
- When changing how the system prompt or tool definitions are captured

## Not intended for
- Pure logic / helpers → use `architecture`
- Writing tests → use `testing`
- Deep plugin API mechanics → load the global `opencode-plugin` skill

---

## Entry points

| File | Role |
|------|------|
| `model-usage-server.ts` | Server plugin: `experimental.chat.system.transform` (system capture) + `tool.definition` (tool defs capture) |
| `model-usage.tsx` | TUI entry: registers `/analyze` (ctrl+shift+a) and `/usage` (ctrl+shift+u) via `registerSlashCommand` |
| `model-usage/analyze.tsx` | Analyze dialog + tabbed breakdown + raw visor (`v`) |
| `model-usage/usage.tsx` | Usage dialog (month/week/day views) |
| `model-usage/sidebar.tsx` | Sidebar slots (cost + quota indicators) |

## Server-side rules (MUST)

- **Title-gen skip**: the tiny "You are a title generator" system must never be captured — guard before storing.
- **Drift throttling**: keep the 32-token drift threshold + 5-min timestamp refresh pattern; don't write the file when nothing material changed.
- **System snapshots** are pre-injection by design (hook order). The final system comes from the wlib sidecar (`wlib/system`, written by persona-injector). Never reorder hooks by renaming files — rely on the sidecar.
- `tool.definition` accumulates per-session tool defs; rebuild `rawText` from ALL accumulated defs, not just the latest.

## Dialog rules (MUST)

- Register dialogs via `registerDialogKeyLayer` + `useDialogSizing` + `makeScrollState` from wlib — never hand-roll key layers or scroll state.
- Sizing: pass the desired size/height (`useDialogSizing(api, { size, maxHeight })`) — it falls back to fit the terminal. Hardcoding `maxHeight={40}` or `setSize("large")` is a regression.
- Colors: `resolveThemeColors(api.theme.current)` — values are RGBA objects, pass them through (never string-coerce).
- Small no-scrollbox dialogs (error states) may keep `setSize("medium")` — no sizing hook needed.

## Deployment (verify after changes)

Sync to the live plugins folder using the `deploy` skill (cp entry points + rsync mirror with exclusions + runtime-artifact preservation). Do NOT use raw `cp -r` — it ships test files and can clobber `.usage-cache.json`.

- Restart opencode to load changes (plugins load at startup).
- Keep the deployed copy in sync with the repo — flag drift in the quality-check report.

## References
- `opencode-plugin` (global) — plugin API mechanics, hooks, loading order
- `opencode-dialogs` (global) — dialog UX patterns
- `wlib` — shared helpers used by every entry point
- `architecture` — where logic belongs
