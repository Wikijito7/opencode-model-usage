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
| v2 server plugin | `model-usage/server.ts` | `Plugin.define` + `session.hook("context")`; no TUI/JSX |
| v2 TUI entry | `model-usage/tui.tsx` | `Plugin.define` + `createV2Host`; slots + commands |
| v2 TUI dialogs | `model-usage/v2/{analyze,usage}.tsx` | presentation only; no business logic |
| v2 sidebar | `model-usage/v2/sidebar.tsx` | presentation only |
| v2 data strategy | `model-usage/v2/{backend,message-adapter,sidebar-domain}.ts` | pure helpers, fully testable |
| v1 (deprecated) | `model-usage.tsx`, `model-usage-server.ts`, `model-usage/{analyze,usage,sidebar}.tsx` | transition only; v1 adapter, never loaded by v2 |
| Pure domain | `model-usage/{analyze,usage}-domain.ts` | pure functions, fully testable |
| Pure helpers | `model-usage/helpers/*.ts` | pure utilities, fully testable |
| Data layer | `model-usage/{db,cache,quota}.ts` | sqlite / JSON cache / quota fetch |
| Shared code | `model-usage/wlib/` (submodule) | ALL cross-cutting helpers live here — never duplicate |

## Conventions (MUST)

- **Pure modules** (`helpers/*`, `*-domain.ts`, `v2/*-domain.ts`, `v2/*-adapter.ts`, `v2/backend.ts`) must not import `@opencode/plugin`, `@opencode/plugin/tui`, `solid-js`, or the plugin API — that's what makes them testable with `bun:test`.
- **Domain before UI**: put logic in `analyze-domain.ts` / `usage-domain.ts` / `helpers/*` / `v2/*-domain.ts`, then have the `.tsx` files call it. No logic in dialogs.
- **Host generation is exclusive**: v2 modules use only the v2 adapter/APIs; v1 modules use only the v1 adapter/APIs. Never mix them in one adapter.
- **System prompt handling** is split by design: the server captures the pre-injection system; the wlib sidecar (`wlib/system`) holds the final system written by persona-injector; `analyze-domain.ts` prefers the override at analyze time (`loadFinalSystemOverride`).
- **Fragment splitting** (`helpers/fragments.ts`) must keep supporting all three separators: 2 blank lines, 1 blank line, and 0 blank lines (agent preamble terminates the persona section).
- **Shared concerns always come from wlib**: scroll, keys, theme, log, reload, clipboard, dialog sizing. Creating local copies is a blocker.

## Blockers (MUST NOT)

- Importing the TUI API or SolidJS inside `helpers/*` or `*-domain.ts`
- Mixing v1 and v2 host APIs in one runtime adapter (v1 files use `createV1Host`, v2 files use `createV2Host`)
- Recreating wlib functionality locally (scroll/keys/theme/log/reload/clipboard/dialog/system)
- Putting business logic inside `.tsx` dialog components
- Adding new files to `model-usage/shared/` — the folder was removed; shared code lives in `wlib/`

## References
- `plugin-development` — entry points, hooks, dialog flow
- `testing` — how to verify pure modules
- `wlib` — what the shared library provides
- `quality-check` — gates before reporting done
