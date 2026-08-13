---
name: architecture
description: "CRITICAL: Load when adding, moving, or refactoring code in this repo. Wrong layering = broken tests and unmaintainable plugin. Defines the module boundaries and conventions."
---

## When to use me
- When creating a new file or module in this repo
- When refactoring or moving code between modules
- When deciding where logic belongs (server vs TUI vs helpers vs domain)

## Not intended for
- Writing tests → use `testing`
- Plugin entry-point wiring (commands, hooks, dialogs) → use `plugin-development`
- Shared-library decisions → use `wlib`

---

## Repo layout

| Area | Location | Rules |
|------|----------|-------|
| Server plugin | `model-usage-server.ts` (root) | opencode hooks only; no TUI/JSX |
| TUI entry | `model-usage.tsx` (root) | registers commands via `registerSlashCommand` |
| TUI dialogs | `model-usage/analyze.tsx`, `usage.tsx` | presentation only; no business logic |
| Sidebar slots | `model-usage/sidebar.tsx` | presentation only |
| Pure domain | `analyze-domain.ts`, `usage-domain.ts` | pure functions, fully testable |
| Pure helpers | `model-usage/helpers/*.ts` | pure utilities, fully testable |
| Data layer | `db.ts`, `cache.ts`, `quota.ts` | sqlite / JSON cache / quota fetch |
| Shared code | `model-usage/wlib/` (submodule) | ALL cross-cutting helpers live here — never duplicate |

## Conventions (MUST)

- **Pure modules** (`helpers/*`, `*-domain.ts`) must not import `@opencode-ai/plugin/tui`, `solid-js`, or the plugin API — that's what makes them testable with `bun:test`.
- **Domain before UI**: put logic in `analyze-domain.ts` / `usage-domain.ts` / `helpers/*`, then have the `.tsx` files call it. No logic in dialogs.
- **System prompt handling** is split by design: the server captures the pre-injection system; the wlib sidecar (`wlib/system`) holds the final system written by persona-injector; `analyze-domain.ts` prefers the override at analyze time (`loadFinalSystemOverride`).
- **Fragment splitting** (`helpers/fragments.ts`) must keep supporting all three separators: 2 blank lines, 1 blank line, and 0 blank lines (agent preamble terminates the persona section).
- **Shared concerns always come from wlib**: scroll, keys, theme, log, reload, clipboard, dialog sizing. Creating local copies is a blocker.

## Blockers (MUST NOT)

- Importing the TUI API or SolidJS inside `helpers/*` or `*-domain.ts`
- Recreating wlib functionality locally (scroll/keys/theme/log/reload/clipboard/dialog/system)
- Putting business logic inside `.tsx` dialog components
- Adding new files to `model-usage/shared/` — the folder was removed; shared code lives in `wlib/`

## References
- `plugin-development` — entry points, hooks, dialog flow
- `testing` — how to verify pure modules
- `wlib` — what the shared library provides
- `quality-check` — gates before reporting done
