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
| Shared server entry | `model-usage-server.ts` | combined default `{ id, server, setup }`: v1 reads `server`, v2 reads `id`+`setup`; the v2 setup is delegated to `server-setup.ts` |
| v2 server setup | `model-usage/server-setup.ts` | plain `setup` export, **no default** (not a directory entrypoint); `session.hook("context")`; no TUI/JSX; **type-only** `@opencode/plugin` import so the root v1 file stays loadable |
| v2 TUI entry | `model-usage/tui.tsx` | `Plugin.define` + `createV2Host`; slots + commands |
| v2 TUI dialogs | `model-usage/v2/{analyze,usage}.tsx` | presentation only; no business logic |
| v2 sidebar | `model-usage/v2/sidebar.tsx` | presentation only |
| v2 data strategy | `model-usage/v2/{backend,message-adapter,sidebar-domain}.ts` | pure helpers, fully testable |
| v1 (deprecated) | `model-usage.tsx`, `model-usage/{analyze,usage,sidebar}.tsx` | transition only; v1 adapter; the v1 server shares the root `model-usage-server.ts` |
| Pure domain | `model-usage/{analyze,usage}-domain.ts` | pure functions, fully testable |
| Pure helpers | `model-usage/helpers/*.ts` | pure utilities, fully testable |
| Data layer | `model-usage/{db,cache,quota}.ts` | sqlite / JSON cache / quota fetch. OpenCode DB is opened `readonly: true` on every path — **never** write or create/modify indexes |
| Shared code | `model-usage/wlib/` (submodule) | ALL cross-cutting helpers live here — never duplicate |

## Home-relative paths (environment)

Every plugin-owned config/data/export path and the `opencode-go` auth lookup is
built from `homedir()` (which reads `$HOME`), so it resolves under the **process
`HOME`**:

- **v1 (normal root):** `HOME` = the real user home → e.g.
  `~/.config/opencode/plugins/model-usage/…`, `~/.config/opencode/export`,
  `~/.local/share/opencode/auth.json`.
- **v2 (sandbox):** the launcher exports `HOME="$V2_HOME"` (plus
  `OPENCODE_CONFIG_DIR` / XDG roots) → the same code resolves under `$V2_HOME`,
  e.g. `$V2_HOME/.config/opencode/plugins/model-usage/…`.

This is **path/config isolation, not an OS security boundary** — redirecting
`HOME` changes which default paths resolve, but it does not block filesystem
access; absolute paths, symlinks, and shared mounts still reach v1 files.

## Conventions (MUST)

- **Pure modules** (`helpers/*`, `*-domain.ts`, `v2/*-domain.ts`, `v2/*-adapter.ts`, `v2/backend.ts`) must not import `@opencode/plugin`, `@opencode/plugin/tui`, `solid-js`, or the plugin API — that's what makes them testable with `bun:test`.
- **Solid-dependent modules must be `.tsx`**: under OpenCode 2.0.27's local plugin loader, the Solid/OpenTUI runtime transform is applied **only** to `.tsx`/`.jsx`. So any plugin-local module that returns JSX or uses Solid/OpenTUI runtime APIs (`createRoot`, `createEffect`, signals, components) and relies on that rewrite must use `.tsx` (e.g. `v2/{analyze,usage}.tsx`, `v2/sidebar.tsx`, wlib `ui/owned-instance.tsx`); the same code in a `.ts` file silently fails to transform. Pure `.ts` helpers and type-only imports (`import type { JSX } from "solid-js"`) stay `.ts`. This is a property of this host's loader, not a blanket rule that every Solid runtime import in every environment requires `.tsx`.
- **Usage DB is schema-aware and read-only**: `db.ts` detects v1 (`message`/`session`), v2 (`session_message`/`session_v2`), or hybrid databases. Source selection is **per table family and independent**: the message-table family and the session-table family are each ordered by their own newer `MAX(time_created)` (ties prefer v2), and each reads its newer table first, falling back to the older one only when the newer has no rows in the window (never summing both, never a row-level merge; the two family choices are not coupled). Tradeoff: in a partially migrated DB older-generation rows for a window are omitted whenever the newer source has any matching rows. Every path opens `readonly: true` and issues only `SELECT`s.
- **Domain before UI**: put logic in `analyze-domain.ts` / `usage-domain.ts` / `helpers/*` / `v2/*-domain.ts`, then have the `.tsx` files call it. No logic in dialogs.
- **Host generation is exclusive**: v2 modules use only the v2 adapter/APIs; v1 modules use only the v1 adapter/APIs. Never mix them in one adapter.
- **System prompt handling** is split by design: the server captures the pre-injection system; the wlib sidecar (`wlib/src/core/system`) holds the final system written by persona-injector; `analyze-domain.ts` prefers the override at analyze time (`loadFinalSystemOverride`).
- **Fragment splitting** (`helpers/fragments.ts`) must keep supporting all three separators: 2 blank lines, 1 blank line, and 0 blank lines (agent preamble terminates the persona section).
- **Shared concerns always come from wlib**: scroll, keys, theme, log, reload, clipboard, dialog sizing. Creating local copies is a blocker.

## Blockers (MUST NOT)

- Importing the TUI API or SolidJS inside `helpers/*` or `*-domain.ts`
- Putting JSX/Solid code in a `.ts` file — under the OpenCode 2.0.27 local plugin loader, Solid-dependent modules are `.tsx` (the transform covers only `.tsx`/`.jsx`)
- Mixing v1 and v2 host APIs in one runtime adapter (v1 files use `createV1Host`, v2 files use `createV2Host`)
- Recreating wlib functionality locally (scroll/keys/theme/log/reload/clipboard/dialog/system)
- Putting business logic inside `.tsx` dialog components
- Opening the OpenCode SQLite database writable (omitting `{ readonly: true }`) or running any DDL/index creation against it — the plugin is a read-only consumer
- Adding new files to `model-usage/shared/` — the folder was removed; shared code lives in `wlib/`

## References
- `plugin-development` — entry points, hooks, dialog flow
- `testing` — how to verify pure modules
- `wlib` — what the shared library provides
- `quality-check` — gates before reporting done
