# OpenCode v1 → v2 Migration Guide (cross-repository)

> **Status: the v2 migration baseline is committed locally on branch `v2`
> (HEAD `97baa06`, which includes the reviewer-driven fixes, the schema-aware
> `/usage` SQLite fix (v1/v2/hybrid detection), their tests, and the wlib pin at
> `f95b73e`).** On top of HEAD the wlib submodule
> bump to `5cab3e1` (with the pin references that follow it) is **staged**,
> while the stable-owner integration (the export controller held in a lazy wlib
> `createOwnedInstance`) and the accompanying skill/migration refinements are
> **unstaged working-tree changes** on branch `v2`; none of it is committed or
> approved yet.
> Nothing has been pushed or opened as a PR for `opencode-model-usage` yet, and
> final review/QA approval is **pending**.
> **Deployment is in place in the shared normal root:** the dual-compatible
> `model-usage` and `persona-injector` trees are synced into
> `~/.config/opencode/plugins` (the one normal root both generations discover),
> with v1 `tui.json` keeping the loose `.tsx` entries and v2 `cli.json` pointing
> at the plugin **directories** (`./plugins/model-usage`,
> `./plugins/persona-injector`). Tests and parse checks passed, and the user has
> confirmed the normal-root runtime test works. No isolated `$V2_HOME` was used
> (it remains optional, for data separation only). The push/PR and review/QA
> steps in §8 remain outstanding.

This document is the cross-repository plan for porting the Wokis OpenCode
plugins from the OpenCode **v1** plugin API to OpenCode **v2**. It is the shared
reference for the three migration issues and for the consuming repositories.

---

## 1. Target and coexistence policy

- **Target host:** OpenCode **2.0.27**.
  Local reference checkout:
  `/Users/cristianpc/.local/share/opencode/repos/github.com/anomalyco/opencode`
  (tracks the `dev` branch; at audit time `package.json` → `"version": "2.0.31"`,
  ahead of the 2.0.27 target). The v2 API claims below were confirmed on 2.0.27
  and re-checked unchanged on the current checkout.
- **v1 and v2 coexist as separate executables:** `opencode` (v1) and
  `opencode2` (v2). They can be installed side by side, but **a plugin
  implementation cannot be shared**: v1 plugins do not work in v2. A plugin must
  be ported (source: migration issue #4, “Additional context”).
- **Policy:** each repository ships a **v2 implementation as the only supported
  path going forward**, plus a **deprecated v1 adapter** for a transition
  period. Do **not** mix v1 and v2 host APIs inside the same runtime adapter.
- **Coordinated release:** all repositories cut **2.0.0** together. v2 is gated
  on wlib first; consumers bump their submodule only after wlib v2 tests pass.

### Migration issues (deprecation / removal)

| Repo | Migrate to v2 | Remove deprecated v1 |
| --- | --- | --- |
| opencode-wlib | [#4](https://github.com/Wikijito7/opencode-wlib/issues/4) | [#5](https://github.com/Wikijito7/opencode-wlib/issues/5) |
| opencode-persona-injector | [#34](https://github.com/Wikijito7/opencode-persona-injector/issues/34) | [#35](https://github.com/Wikijito7/opencode-persona-injector/issues/35) |
| opencode-model-usage | [#47](https://github.com/Wikijito7/opencode-model-usage/issues/47) | [#50](https://github.com/Wikijito7/opencode-model-usage/issues/50) |

---

## 2. Repository order

Migrate in this order; each step is a prerequisite for the next.

1. **opencode-wlib** — shared contract. The consumer plugins depend on its API
   surface, so it must land first (issue #4).
2. **opencode-persona-injector** — server hooks + TUI + the system-snapshot
   writer that model-usage reads (issue #34).
3. **opencode-model-usage** — server hooks, SQLite/data layer, TUI dialogs,
   snapshot reader (issue #47).
4. **notifications** — planned fourth repository. **Not present in the local
   workspace and not found in the public `Wikijito7` org as of this writing.**
   Scope and ownership must be confirmed by the Lead Coordinator (see §11).

---

## 3. Exact v1 → v2 naming changes

v1 column = what the current code in these repositories uses. v2 column = what
the OpenCode 2.0.27 reference exposes (file path cited per row).

### 3.1 Package and entrypoints

| Concern | v1 (current repos) | v2 (OpenCode 2.0.27 reference) |
| --- | --- | --- |
| Plugin package | `@opencode-ai/plugin`, `@opencode-ai/plugin/tui` | `@opencode/plugin`, `@opencode/plugin/tui`, `@opencode/plugin/effect`, `@opencode/plugin/host`, `@opencode/plugin/runtime` (`reference/packages/plugin/package.json`) |
| Plugin module shape | TUI: `const tui: TuiPlugin = async (api) => {…}` + `export default { id, tui }` (e.g. `model-usage.tsx:20`, `persona-injector.tsx:71`) | `Plugin.define({ id, setup })` (`reference/packages/plugin/src/tui/plugin.ts`, `.../src/promise/plugin.ts`, `.../src/effect/plugin.ts`) |
| Server module shape | `default = { id, server, setup }` (v1 reads `server`; `PluginModule = { id?, server, tui?: never }`) — e.g. `model-usage-server.ts` | v2 reads `id` + `setup`, ignoring the extra `server` property (module schema ignores unknown keys) |
| Entry-file resolution | Convention-based single entry | `Host.resolve` resolves distinct **`server`** (then `index`), **`tui`**, **`rpc`** subpaths (`reference/packages/plugin/src/host.ts`) |
| Client / SDK | `@opencode-ai/sdk/v2` (`model-usage-server.ts:3`) | `@opencode/client` (+ `@opencode/schema/*`, `@opencode/protocol/*`) — **exact v2 client surface to validate** |

### 3.2 Hooks

v1 registers a flat object map of dotted hook names. v2 registers **domain
methods** imperatively.

| v1 hook (current code) | v2 equivalent (reference) |
| --- | --- |
| `"experimental.chat.system.transform"` (`model-usage-server.ts:135`, `persona-injector-server.ts:81`) | `ctx.session.hook("context", …)` — `SessionContext.system: Array<SystemPart>` (`reference/packages/plugin/src/effect/session.ts`). **Closest match; timing/ordering semantics must be validated.** |
| `"chat.message"` (`persona-injector-server.ts:146`) | `ctx.session.hook("prompt", …)` and/or `ctx.event.subscribe` (`.../effect/session.ts`, `.../effect/event.ts`) — validate which carries the agent identity |
| `"tool.definition"` (`model-usage-server.ts:192`) | No one-to-one hook. Use `ctx.tool.transform` / `ctx.tool.hook("execute.before"/"execute.after")` (`.../effect/tool.ts`), or drop the Tool Defs feature (issue #47) |
| title-generator calls | v2 distinguishes request **kind** `"primary" \| "compaction" \| "title" \| "generate"` (`.../effect/session.ts` `SessionRequestKind`) — can replace the string-sniffing `isTitleGenerator` guard |

Other v2 runtime hooks available: `session.hook("compaction" \| "generate" \|
"model.request" \| "http.request" \| "http.response" \| "retry" \|
"experimental.ws.*")`, plus `ctx.event.subscribe`.

### 3.3 TUI context

| v1 | v2 |
| --- | --- |
| `api: TuiPluginApi` function argument (all repos) | `Context` obtained in `setup(ctx)` and via `usePlugin()` / `PluginContextProvider` (`reference/packages/plugin/src/tui/context.ts`, `.../tui/solid.ts`) |
| `api.renderer` | `ctx.renderer` (`CliRenderer`) |
| `api.client` | `ctx.client` (`OpenCodeClient`) |
| `api.theme.current` | `ctx.theme` (`ResolvedTheme`) + `ctx.themeMode` |
| `api.route.current` | `ctx.ui.router.current()` / `ctx.ui.router.navigate()` |
| `api.state` + `api.event` | `ctx.data` (`on`, `listen`, `session`, `project`, `shell`, `location.*`) |

### 3.4 Command / keymap

| v1 (`wlib/src/core/command.ts`, `keys.ts`; `model-usage/analyze.tsx:855`) | v2 (`reference/packages/plugin/src/tui/context.ts`) |
| --- | --- |
| `api.keymap.registerLayer({ commands, bindings })` | `ctx.keymap.layer(() => KeymapLayer)` |
| Command `name` | Command `id` |
| Command `category` | Command `group` |
| `namespace: "palette"` | `palette: true` |
| `slashName` | `slash: { name, aliases?, arguments? }` |
| Inline key binding object `{ key, cmd, desc }` | `bind` on the command — sufficient by itself for the default binding; the layer's `bindings: readonly string[]` list is only for **configured overrides**, not needed for the default |
| — | New: `enabled`, `suggested`, `priority`, `mode`, `target`, `keymap.dispatch(id)`, `keymap.shortcuts(id)` |

Field mapping is confirmed by issue #4 (wlib).

**Keymap `mode` (confirmed on 2.0.27):** a `KeymapLayer` that omits `mode`
defaults to `base`, and an open dialog pushes `modal` — so a layer left at the
host default is inactive exactly while its dialog is visible. wlib sets
`mode: "global"` on every layer it registers (`toV2Layer`, `registerCommand`).

### 3.5 Slots

| v1 (`api.slots.register({ order, slots })`) | v2 (`ctx.ui.slot(claim)`) |
| --- | --- |
| `sidebar_content` (`model-usage.tsx:11`) | `sidebar.content` |
| `session_prompt_right` (`persona-injector.tsx:48`) | `prompt.footer` (candidate — see §11) |
| `home_prompt_right` (`persona-injector.tsx:51`) | `home.footer` (candidate — see §11) |
| ordering via `order: number` | placement keys `prepend \| append \| before \| after \| replace` on an absolute `SlotPath` |

Full v2 slot paths (`reference/packages/plugin/src/tui/context.ts` `SlotMap`):
`app`, `home.footer`, `home.footer.status`, `prompt.footer`,
`prompt.footer.status`, `prompt.footer.file`, `session.composer.top`,
`session.panel`, `sidebar.content`, `sidebar.footer`.

### 3.6 Dialog / toast

| v1 | v2 (`reference/packages/plugin/src/tui/context.ts`) |
| --- | --- |
| `api.ui.dialog.replace(render)` | `ctx.ui.dialog.show(render, onClose?)` |
| `api.ui.dialog.setSize(size)` | `ctx.ui.dialog.set({ size, centered })` |
| `api.ui.dialog.clear()` | `ctx.ui.dialog.clear()` |
| `api.ui.toast({ message })` | `ctx.ui.toast.show({ title?, message, variant?, duration?, sessionID? })` |
| — | New: `dialog.alert / confirm / prompt / select` |

**`dialog.show` render callback may re-run (confirmed on 2.0.27):** the `render`
callback is reactive — it may re-evaluate whenever a signal it reads in its body
changes. Stateful **long-lived controllers**, such as `createExportController`
(which registers a `createEffect` key layer + an `onCleanup` flash timeout), must
be allocated **once per dialog** in a wlib `createOwnedInstance(factory)` wrapper
constructed **outside** the callback. Call the lazy `.get()` as the **first
operation inside** the render callback, so the standalone Solid root it opens is
created at that call site and inherits the dialog's `Keymap.Provider` context;
later re-runs return the identical instance. Call `.dispose()` from `onClose`
(covers escape/replacement/clear).

This is **not** a blanket ban on the render callback: component lifecycle
(`onMount`/`onCleanup`) and dialog-scoped registrations inside the callback are
fine. The single rule is to avoid **recreating the long-lived controller on each
render**. (Repo-local authority: `plugin-development` for the lifecycle rule,
`wlib` for the `createOwnedInstance` API.)

### 3.7 Theme

| v1 | v2 |
| --- | --- |
| `api.theme.current` with drifting property names (`text`/`foreground`, `textMuted`/`muted`, `error`/`red`), normalized by `wlib/src/core/theme.ts` `resolveThemeColors` | `ctx.theme` is a typed **`ResolvedTheme`** with semantic tokens (`text.base`, `text.muted`, `background.base`, `border.base`, `scrollbar.base`, `diff.*`, `syntax.*`, …; `reference/packages/theme/src/tui/types.ts`) |
| RGBA values passed through as opaque objects | Keep **RGBA pass-through**, never string-coerce (issue #4) |

**Resolved theme keys (2.0.27):** `context.theme` is a `ResolvedTheme`, so
action states are `focused` / `selected` / `base` — the `$focused`/`$selected`
spelling appears only in the raw theme JSON a plugin authors, never in the
resolved context. `primary` resolves `background.action.primary.focused` first,
then `.selected`, then `.base`; `selectedText` resolves
`text.action.primary.focused` → `.selected` → `.base`. Transparent values
(`"transparent"` or zero-alpha RGBA) are treated as absent and skipped (the
default theme paints only `focused`); non-transparent RGBA objects are preserved
by identity.

### 3.8 Storage

| v1 | v2 |
| --- | --- |
| Plugin-owned JSON files (`system-tokens.json`, `tool-defs.json`, `.usage-cache.json`), `model-usage-server.ts:9-17` | TUI: `ctx.storage.store(key, { initial })` (durable) and `ctx.storage.memory(key, { initial })` (ephemeral); server: `ctx.storage.get/set/remove/scan` (`.../tui/context.ts`, `.../effect/storage.ts`) |
| Cross-plugin sidecar `wlib/src/core/system.ts` (v1 normal root: `~/.config/opencode/plugins/persona-injector/system-snapshots.json`) | v2 storage is **plugin-scoped** and does not automatically replace cross-plugin sharing — explicit design decision needed (issue #4; §11) |

> **Path resolution under v2.** Every location above is built with `homedir()`
> (which reads `$HOME`). The default (and actual) deployment shares the normal
> root, so both generations resolve these to the same
> `~/.config/opencode/plugins/model-usage/…` files. Only if the **optional**
> isolated sandbox is used does the v2 process run with `HOME="$V2_HOME"` and
> resolve a separate path — `system-tokens.json` / `tool-defs.json` /
> `.usage-cache.json` →
> `$V2_HOME/.config/opencode/plugins/model-usage/…`, the persona-injector
> sidecar → `$V2_HOME/.config/opencode/plugins/persona-injector/system-snapshots.json`,
> and the default export dir → `$V2_HOME/.config/opencode/export` (v1:
> `~/.config/opencode/export`). That deployment copies no credentials or
> database files into the sandbox (`$V2_HOME/.local/share/opencode/auth.json`
> and `…/opencode.db` start absent), so the two trees would resolve to separate
> user state. This is path/config isolation only, not an OS security boundary:
> it changes which default paths resolve under the process `HOME`, but absolute
> paths, symlinks, and shared mounts can still reach the v1 tree.

### 3.9 Data and event naming

| v1 | v2 |
| --- | --- |
| `api.state.config`, `api.state.provider`, `api.state.session.messages(id)` (`model-usage/sidebar.tsx`) | `ctx.data.location.model/provider`, `ctx.data.session.message.list/get`, `ctx.data.session.status/cost`, etc. |
| `api.event` / ad-hoc event listeners | `ctx.data.on(type, handler)` / `ctx.data.listen(handler)` |
| Flat/legacy event names | Namespaced v2 events: `session.created`, `session.agent.selected`, `session.model.selected`, `session.compacted`, `session.status`, `session.idle`, `config.updated`, `project.updated`, `plugin.updated`, `server.connected`, `global.disposed`, `tui.*` (`reference/packages/schema/src/*`, assembled by `reference/packages/protocol/src/groups/event.ts` from `EventManifest.ServerDefinitions`). Validate the exact set against `@opencode/schema/event-manifest`. |

### 3.10 Module extension (Solid transform)

Under OpenCode 2.0.27's local plugin loader, the Solid/OpenTUI JSX transform is
applied **only** to `.tsx`/`.jsx`. So any plugin-local module that returns JSX
or uses Solid/OpenTUI runtime APIs (`createRoot`, `createEffect`, signals) and
relies on that rewrite must use a `.tsx` extension (e.g.
`v2/{analyze,usage}.tsx`, `v2/sidebar.tsx`, wlib `ui/owned-instance.tsx`); the
same code in a `.ts` file silently fails to transform. Pure `.ts` helpers and
type-only imports (`import type { JSX } from "solid-js"`) stay `.ts`.

This is a property of this host's loader, not a blanket claim that every Solid
runtime import in every environment requires `.tsx` — a `.ts` module transpiled
by another toolchain is unaffected.

---

## 4. Exact relevant source files by repository

### opencode-wlib (`/Volumes/eSSD1/IdeaProjects/opencode-wlib`)

- `src/core/command.ts` — `api.keymap.registerLayer` → `ctx.keymap.layer`; command metadata field mapping.
- `src/core/keys.ts` — dialog key layer → v2 keymap layer.
- `src/core/theme.ts` — `resolveThemeColors` → semantic tokens, RGBA pass-through.
- `src/ui/dialog.tsx` — accept v2 context/renderer; `ctx.ui.dialog.set({ size })`; preserve responsive fit.
- `src/ui/export-controller.tsx` — v2 keymap layer + dialog lifecycle + theme.
- `src/ui/help-overlay.tsx`, `src/ui/export-overlay.tsx`, `src/ui/export-result-overlay.tsx`, `src/ui/copied-flash.tsx` — review for host-agnostic/v2 assumptions.
- `src/core/system.ts` — decide filesystem sidecar vs v2 storage abstraction.
- Keep pure: `clipboard`, `dialog-fit`, `export`, `export-state`, `file`, `help`, `log`, `reload`, `scroll`, system snapshot math.
- `test/*.test.ts` — update mocks from `registerLayer`/v1 command metadata to `keymap.layer`.
- `README.md`, `MIGRATION.md` — v2 terminology + consumer sequence.

### opencode-persona-injector (`/Volumes/eSSD1/IdeaProjects/opencode-persona-injector`)

- `persona-injector-server.ts` — server hooks (`experimental.chat.system.transform`, `chat.message`) → `Plugin.define` + v2 session hooks.
- `persona-injector.tsx` — TUI module `{ id, tui }` → v2 setup API; slots → `ctx.ui.slot`; `registerSlashCommand` → `ctx.keymap.layer`.
- `persona-injector/dialog.tsx` — dialog/toast/theme/renderer APIs.
- `persona-injector/prompt-indicator.tsx` — slot component.
- `persona-injector/config.ts`, `persona-injector/personas.ts` — preserve config + persona JSON compatibility.
- `.gitmodules` — wlib submodule pin; `personas/*`; `tests/*`.

### opencode-model-usage (`/Volumes/eSSD1/IdeaProjects/opencode-model-usage`)

- `model-usage-server.ts` — combined default `{ id, server, setup }`: v1 `server` hook map + v2 `setup` (`session.hook("context")`); snapshot ordering decision. The v2 setup helper lives in `model-usage/server-setup.ts` (no default; see §13.10).
- `model-usage.tsx` — `{ id, tui }` → v2 setup; `Api.slots.register` → `ctx.ui.slot`.
- `model-usage/sidebar.tsx` — `api.state`/`api.event` → `ctx.data`; slot input.
- `model-usage/usage.tsx`, `model-usage/analyze.tsx` — `keymap.registerLayer` → `ctx.keymap.layer`; dialogs.
- `model-usage/quota.ts` — Copilot quota (internal endpoint) + opencode-go quota review (§10).
- `model-usage/db.ts`, `model-usage/cache.ts` — data layer (§9).
- `model-usage/version.ts` — plugin name + version (coordinated 2.0.0).
- `model-usage/helpers/*` — must stay free of `@opencode-ai/plugin/tui`/SolidJS.
- `.gitmodules`; `tests/*`; `README.md`.

---

## 5. Config changes

### 5.1 `tui.json` → `cli.json` (and `opencode.json(c)` plugins)

| v1 | v2 |
| --- | --- |
| **(shared normal root)** `~/.config/opencode/tui.json` → `{ "plugin": [ "./plugins/model-usage.tsx" ] }` (v1 TUI entry registered explicitly) | **(optional isolated data root)** `$V2_HOME/.config/opencode/cli.json` → `{ "$schema": "https://opencode.ai/v2/cli.json", "plugins": [] }` — **TUI-only**. Local plugin **directories** under `~/.config/opencode/plugins/` (or `$V2_HOME/...` if an isolated data root is used) are auto-discovered by the TUI (see §5.2). The sandbox is optional and only separates user data, not discovery |
| `opencode.json` plugin registration | `opencode.json(c)` `plugins` field (same `ConfigPlugin.Plugins` array) — the **server/config** plugin list |

- Field key is **`plugin` (v1) → `plugins` (v2)**.
- **Two distinct `plugins` fields in v2 — do not conflate them:**
  - `opencode.json(c)` `plugins` → the **core/server/config** plugin list
    (`reference/packages/schema/src/config/plugin.ts`;
    `reference/packages/core/src/config/normalize.ts`).
  - `cli.json` `plugins` → the **TUI-only** plugin list
    (`reference/packages/tui/src/config/index.tsx`;
    `reference/packages/cli/src/config/schema.ts`).
- v2 plugin entry: `string | { package: string, options?: Record<string, unknown> }`.
  These arrays are for **npm packages** (and enable/disable/ordering directives);
  local plugins are discovered from their directories.
- **A configured local plugin target must be a directory.** Explicit local
  **file** config targets are rejected — do not point `tui.json` / `cli.json` /
  `opencode.json(c)` at a loose deprecated v1 entry file such as
  `./plugins/persona-injector.tsx`. v2 resolves a plugin **directory** through
  `Host.resolve`, which looks for the `server` entry (then falls back to
  `index`) and the `tui` entry. A dual-generation plugin can share the normal
  root with a **flat combined server entry** plus a **TUI-only directory**:

  ```
  ~/.config/opencode/plugins/          # the shared normal root — v1 AND v2 discover here
    model-usage-server.ts              # shared v1/v2 server entry { id, server, setup } (flat file)
    model-usage/                       # v2 TUI directory — NO package-root server/index
      tui.tsx                          # TUI entry (Plugin.define)
      server-setup.ts                  # v2 setup helper (imported by the flat root file)
  ```

  Such a directory is auto-discovered; it does **not** need a `plugins` entry.
  A plugin *may* keep a package-root `server.ts` / `index.ts`; `model-usage`
  deliberately does **not**, because its v2 server is the shared flat root file —
  a package-root server would load a second, conflicting server. The normal root
  is shared by both generations; an isolated `$V2_HOME` is **optional** and only
  separates user data.
- OpenCode ships an automatic migration of `tui.json` + legacy `kv.json` into
  `cli.json` (`reference/packages/cli/src/config/migrate.ts`,
  `migrateV1`), including `plugin` → `plugins` and `plugin_enabled`.
  `SchemaURL` is `https://opencode.ai/v2/cli.json`
  (`reference/packages/cli/src/config/schema.ts`).

> ⚠️ **Same normal root is supported — a shared root loads one server per
> generation.** v2 core (server) discovery admits bare `.ts`/`.js` children, so
> the flat `model-usage-server.ts` is discovered by both generations. It carries
> the combined default `{ id, server, setup }`, so v2 accepts it (`id` + `setup`,
> extra `server` ignored) while v1 uses `server` — no rejection. A directory with
> no server entry (e.g. `model-usage/` with only `tui.tsx`) is simply **skipped**
> by core discovery, so the shared root never loads two servers. An isolated
> `$V2_HOME` is **optional**; it separates user data, not discovery.

### 5.2 Discovery / layout (core vs TUI)

**Core (server) discovery** — `reference/packages/core/src/plugin/source-directory.ts`
(`names = ["plugin", "plugins"]`, `discover`):

- Scans the **immediate children** of **both** `<configDir>/plugin/` **and**
  `<configDir>/plugins/` (and the project equivalents).
- Admits **bare `.ts`/`.js` files** and **directories**; a symlink is admitted if
  it targets a `.ts`/`.js` file or a directory.

**TUI discovery** — `reference/packages/tui/src/plugin/discovery.ts`
(`localPluginDirectories` + `discoverPluginTargets`, consumed in
`reference/packages/tui/src/plugin/context.tsx`):

- Scans only the **plural** `<configDir>/plugins/` (and the project
  `.opencode/plugins/`).
- Admits **immediate directories / symlinks-to-dirs only** — never bare files.

**Entrypoint resolution** — `Host.resolve`
(`reference/packages/plugin/src/host.ts`): for a directory target it looks for
the server entry as **`server` first, then `index`**, the TUI entry as **`tui`**,
and rpc as `rpc`.

**Consequences:**

- A plugin that must serve **both** generations can share the plural `plugins/`
  root using a **combined flat server entry** (`default = { id, server, setup }`)
  plus a **TUI-only directory** (`tui.tsx`, no package-root `server.ts`/`index.ts`).
  `model-usage` uses exactly this layout. See §5.1.
- Because core discovery also admits **bare `.ts`/`.js` children**, a flat
  `*-server.ts` is loaded by v2 — but only if it exports a `{ id, setup }` default.
  The combined default satisfies both generations, so a shared root is safe.
- A directory whose `Host.resolve` finds **no server entrypoint** is **skipped**
  by core discovery (`ConfigPluginSource.scan` returns `[]`), so a TUI-only
  directory does not fail and does not load a second server.
- A configured local plugin target must be a **directory**; explicit local file
  targets are rejected.
- Packages listed in config `plugins` are installed/resolved via npm; only those
  with a resolved `tui` entrypoint are surfaced by `opencode plugin list`
  (`reference/packages/cli/src/commands/handlers/plugin/list.ts`).
- **Auto-discovered:** directory-style plugins under `<configDir>/plugins/`.
  **Must be declared:** external npm packages (and enable/disable/order
  directives).
- **Deployment layout:** a shared normal root holds the combined flat server
  entry (`model-usage-server.ts`), the v1 TUI entry (`model-usage.tsx`, via
  `tui.json`) and the v2 TUI directory (`model-usage/tui.tsx`, resolved as
  `tui`). An isolated `$V2_HOME` is optional and only separates user data.

---

## 6. Dependency / lockfile reconciliation

**Why `package.json`, `bun.lock`/`package-lock.json`, and `node_modules` can
disagree:**

- **wlib is a git submodule, not an npm dependency.** The real version is the
  gitlink commit recorded by the parent repo (`.gitmodules` + index), not
  anything in a lockfile. Current (staged) pin in the model-usage consumer:
  `5cab3e142d910f9931fa6d9253f61ed35a554726` (`origin/v2`, the canonical v2
  commit); HEAD's committed gitlink is still `f95b73e`.
  (persona-injector's pin is tracked separately.)
- **No tracked `package.json` or lockfile exists** in any of the three repos on
  the `v2` branch. The runtime API (`@opencode-ai/plugin@1.4.1` per issue #34) is
  supplied by the host, so nothing anchors it locally.
- **`node_modules/` is gitignored** (`.gitignore` in all three repos), so a
  stale installed copy of the plugin API or an old `cp -r` of `wlib` can sit
  beside a newer submodule pin and silently disagree.
- A lockfile reflects whatever was last installed **locally**; it does not
  follow `git submodule update`.

**Reconciliation checklist:**

- [ ] Bump the submodule in persona-injector to a v2-containing commit (issue #4:
      only after v2 wlib tests pass). model-usage is already bumped to
      `5cab3e142d910f9931fa6d9253f61ed35a554726` (`origin/v2`) as a **staged**
      submodule-pin change (not yet committed; §13.1).
- [ ] `git submodule update --init --recursive` and verify with
      `git submodule status`.
- [ ] If/when a `package.json` is added (npm distribution, issue #47), regenerate
      the lockfile and `node_modules` **together**; never hand-edit one.
- [ ] Remove any stale `node_modules` copy of `wlib` / plugin API before
      verifying.

---

## 7. v1 compatibility adapter strategy and deprecation path

- **wlib (issue #4 → #5):** define the supported v2 compatibility policy and
  release boundary; **do not mix v1 and v2 host APIs in the same runtime
  adapter**. Ship v2 contract; keep deprecated v1 adapters/mocks/docs for one
  transition window, then remove them in #5.
- **persona-injector (issue #34 → #35):** retain deprecated v1 server/TUI
  entrypoints / compatibility wiring during transition; remove them, v1-only
  deps, v1 config guidance, and v1 tests in #35.
- **model-usage (issue #47 → #50):** same, plus remove legacy SQLite/config
  fallbacks in #50.
- **Shape of the adapter:** the v1 and v2 host implementations remain distinct
  (v1 `server()` vs v2 `setup()`), but they share a single server entrypoint
  that exposes **both** — the official default `{ id, server, setup }` — so the
  host picks the surface it knows. No runtime branching mixes both API surfaces.
  Removal is gated on “v2 adoption established”.

---

## 8. Deployment and verification checklist

> **Deployment to the shared normal root has been performed.** The checklist
> below is marked off as items completed; the push/PR and final review/QA steps
> remain outstanding.

- [x] wlib v2 implementation complete; `bun test` green; typecheck green.
- [x] persona-injector v2 complete; ports `wlib`; tests + typecheck green.
- [x] model-usage v2 complete; ports `wlib`; tests + typecheck green.
- [ ] Submodule consumers bumped to the v2 wlib commit (model-usage is pinned at
      `5cab3e142d910f9931fa6d9253f61ed35a554726`, `origin/v2` — currently staged,
      HEAD still `f95b73e`).
- [x] `tui.json` → `cli.json` `plugins` migration verified: v1 `tui.json` keeps
      the loose `.tsx` entries; v2 `cli.json` lists the plugin **directories**
      (`./plugins/model-usage`, `./plugins/persona-injector`).
- [x] Discovery verified under a real `opencode2` install in the **shared normal
      root** (`~/.config/opencode/plugins`): the flat `model-usage-server.ts`
      loads as the v2 server (`id` + `setup`), and `model-usage/tui.tsx` loads as
      the v2 TUI. `model-usage/` has no package-root `server.ts`/`index.ts`.
- [x] (Optional) No **isolated `$V2_HOME`** was used — the shared normal root is
      the actual deployment. The isolated root remains available for data
      separation only and is not required for discovery.
- [x] Sync via the `deploy` skill (one shared-root deploy: `cp` the flat entries +
      additive `rsync` of the `model-usage/` directory; tests and Markdown
      excluded; runtime artifacts preserved; no package-root server entry).
- [x] Runtime verification in `opencode2` (shared normal root): the user has
      confirmed the normal-root runtime test works.
- [ ] No v1 plugin APIs remain in productive code or `wlib` (the deprecated v1
      adapter is still retained for the transition — removal is issue #50).

---

## 9. model-usage SQLite / data migration strategy and fallback

**Current state:** `model-usage/db.ts` opens OpenCode's SQLite database directly
with `bun:sqlite` (`readonly: true`) and queries `session` / message tables;
`model-usage/cache.ts` keeps persistent month/week/day caches; the server writes
`system-tokens.json` and `tool-defs.json`.

All three resolve through `homedir()` (which reads `$HOME`), so the location
depends on the running generation. **v1 (normal root):** database
`~/.local/share/opencode/opencode.db`, plugin files under
`~/.config/opencode/plugins/model-usage/`. **v2 (`HOME="$V2_HOME"`):** database
`$V2_HOME/.local/share/opencode/opencode.db`, plugin files under
`$V2_HOME/.config/opencode/plugins/model-usage/` — a separate path under the
sandbox `HOME`, not the v1 file. This deployment copies no credentials or
database, so a fresh `$V2_HOME` has no database until one is created there and
`/usage` degrades to the explicit empty state.

**Schema-aware historical queries (v1 / v2 / hybrid):** OpenCode ships two
database generations, and `db.ts` now detects which one(s) a database exposes
rather than assuming v1:

| Generation | Message table | Session table | Assistant usage location |
| --- | --- | --- | --- |
| v1 | `message` (`data.role = 'assistant'`) | `session` | `data.modelID`, `data.providerID`, `data.cost`, `data.tokens.input\|output` |
| v2 (2.0.27) | `session_message` (`type = 'assistant'`) | `session_v2` | `data.model.id`, `data.model.providerID`, `data.cost`, `data.tokens.input\|output` |

Detection uses `pragma_table_info` only (a read) plus a `MAX(time_created)`
probe per table family; it never issues DDL or a write. `detectUsageSchema`
classifies the database as a whole (pure v1 / pure v2 / hybrid / unsupported),
but **source selection is per table family and independent**: the
message-table family (`message` vs `session_message`) and the session-table
family (`session` vs `session_v2`) are each ordered separately by their newer
`MAX(time_created)` (ties prefer v2), and each falls back to its older table
only when its primary returns no rows for the requested window. The two family
selections are **not coupled** — a hybrid DB can read v2 messages and v1
sessions (or vice versa) in the same query. The strategy is:

1. **Pure v1** (`message` + `session`) → v1 queries, unchanged behaviour.
2. **Pure v2** (`session_message` + `session_v2`) → v2 queries.
3. **Hybrid** (both generations present, e.g. a v1 DB migrated in place) → for
   **each** family independently, the newer table is the primary and the older
   table is a **fallback used only when the primary returns no rows in the
   requested window**. Selection is **whole-source / newest-first** — a whole
   table is read, never a row-merged view — and the two generations are never
   summed, so a hybrid DB is not double-counted. **Tradeoff:** because a family
   only falls back when its primary is empty for the window, a **partially
   migrated** database (some rows still only in the older generation) can
   **omit** older-generation rows for that window whenever the newer source has
   any matching rows — the fallback is all-or-nothing, not a row-level merge.
4. **Unsupported** (neither generation, or a table missing required columns) → the
   affected query returns an empty result (`[]`, `null`, or an empty
   `UsageData`) instead of surfacing a raw SQLite `no such table` error.

Every `/usage` view is preserved across both schema generations: period/model
totals, raw rows, daily totals/trends, the session leaderboard, and the earliest
usage date. `loadBaseline` (the `session_context_epoch` reader) is unchanged.

**No DB mutation / no index creation:** every runtime path (v1 and v2) opens the
OpenCode database read-only. The plugin **never writes to it and never creates or
modifies indexes**, and the schema-aware queries issue only `SELECT`s. An earlier
v1-only path called `ensureMessageTimeIndex`, which opened a second read-write
connection and ran
`CREATE INDEX IF NOT EXISTS message_time_created_idx ON message(time_created)`;
that call and helper were removed. Queries rely on whatever indexes the installed
DB already has and remain correct without one; installs that already created the
index keep using it.

**v2 strategy:**

1. Introduce a **data-source abstraction** in the data layer (`db.ts` / `cache.ts`)
   so `usage-domain.ts` and `analyze-domain.ts` stay pure and testable.
2. Prefer supported v2 `ctx.data` / client APIs for session/message/cost data.
3. **Fallback:** if no supported v2 API exposes historical per-model usage,
   retain a read-only SQLite path with version detection and graceful
   degradation (empty state + clear UI), or document the feature as unsupported
   (issue #47 acceptance criterion).
4. Migrate plugin-owned JSON persistence to `ctx.storage` **where appropriate**;
   keep the cross-plugin system snapshot contract explicit (§11).

Checklist:

- [x] Map each `db.ts` query to a v2 `ctx.data`/client source; list gaps.
      Historical per-period aggregation has no v2 API on 2.0.27, so the read-only
      SQLite layer is retained for all five `/usage` views.
- [x] Add fallback + error surface for unavailable history.
- [ ] Decide `ctx.storage` vs retained JSON for caches.
- [x] Keep domain layer free of SQLite/host imports.
- [x] Make the historical query layer schema-aware (`detectUsageSchema` +
      v1/v2/hybrid source selection in `db.ts`) so a 2.0.27 v2-only database no
      longer fails with `no such table: message`.

---

## 10. notifications migration and copilot-usage removal

- **notifications** is the fourth repository in the migration order. It is
  **not present in the local workspace and no public `Wikijito7` repository was
  found** as of this writing. Its migration scope, owner, and dependency on the
  other three must be confirmed before work starts (§11).
- **copilot-usage removal:** the Copilot feature lives in
  `model-usage/quota.ts` (`fetchQuotaInfo`, internal endpoint
  `https://api.github.com/copilot_internal/user`, `model-usage/types.ts`
  `CopilotQuotaInfo`) and is surfaced in `model-usage/sidebar.tsx`. Under v2:

  - [ ] Decide whether the Copilot-quota feature **moves to the notifications
        plugin** or is **removed**.
  - [ ] If removed, delete `fetchQuotaInfo`, `CopilotQuotaInfo`, the
        `isCopilot*` sidebar paths, the `GITHUB_TOKEN` requirement, and the
        related README sections.
  - [ ] If moved, define the new plugin’s data contract and keep the internal
        endpoint clearly marked unsupported/experimental.
- opencode-go quota (`GET https://opencode.ai/zen/go/v1/usage`) is independent
  of Copilot; keep or migrate on its own merits.

---

## 11. Open questions / risks

- **Slot mapping (unresolved):** `session_prompt_right` / `home_prompt_right`
  are mapped to `prompt.footer` / `home.footer` per issue #34, but v2 also
  publishes `prompt.footer.status`, `prompt.footer.file`, and
  `home.footer.status`. Which exact path (and placement key) preserves current
  indicator behavior must be validated against a real `opencode2` session.
- **Runtime installation / layout (resolved by 2.0.27 discovery):** core (server)
  discovery scans the immediate children of both `plugin/` and `plugins/` and
  admits bare `.ts`/`.js` plus directories/symlinks; TUI discovery scans
  immediate dirs/symlinks-to-dirs only under the plural `plugins/`; configured
  local targets must be directories; `Host.resolve` tries `server` then `index`
  (server) and `tui` (TUI). A combined dual-generation layout can share the one
  normal   root: a flat server entry with `default = { id, server, setup }` plus a
  TUI-only directory (`tui.tsx`, no package-root server) — see §13.10. Confirmed
  on the shared normal root: the user has confirmed the `opencode2` runtime test
  works (§8).
- **System-prompt observation semantics:** v1 relies on hook registration order
  for `experimental.chat.system.transform`; v2 `session.hook("context")`
  timing/mutability (`SessionContext.system: Array<SystemPart>`) must be
  validated before trusting the snapshot ordering.
- **`tool.definition`:** no direct v2 equivalent; Tool Defs may need redesign or
  removal (issue #47).
- **Cross-plugin sidecar:** v2 storage is plugin-scoped; the
  persona-injector → model-usage system-snapshot contract needs an explicit
  decision (keep filesystem sidecar vs. redesign).
- **`@opencode-ai/sdk/v2` import** in `model-usage-server.ts:3` must be mapped
  to the v2 client surface.
- **Package naming in issue #34** says `@opencode-ai/plugin/tui`; the 2.0.27
  reference package is `@opencode/plugin/tui`. Treat the reference as
  authoritative unless the Coordinator says otherwise.
- **notifications repository:** location and scope unknown (§10).
- **Submodule pin** is staged at `5cab3e142d910f9931fa6d9253f61ed35a554726`
  (`origin/v2`) in model-usage — HEAD's committed gitlink is still `f95b73e`
  (§6, §13.1); persona-injector's pin is tracked separately.

---

## 12. Actionable summary

- [ ] Confirm open questions in §11 with the Lead Coordinator before coding.
- [ ] wlib v2 (#4): port core/command, keys, theme, ui/dialog,
      export-controller; update tests; update MIGRATION.md/README.
- [ ] persona-injector v2 (#34): `Plugin.define`, v2 hooks, slots, keymap,
      dialog/toast, `cli.json`.
- [ ] model-usage v2 (#47): combined v1/v2 server default `{ id, server, setup }`
      (v2 setup in `server-setup.ts`), v2 hooks, `ctx.ui.slot`,
      `ctx.keymap.layer`, `ctx.data`, data-layer abstraction, config.
- [ ] notifications migration (repo TBD).
- [ ] Removal issues #5 / #35 / #50 after v2 adoption.
- [x] Shared normal-root deployment; the user has confirmed the normal-root
      `opencode2` runtime test works (push/PR and final review/QA pending).

---

## 13. Implementation record — opencode-model-usage (v2 branch)

This section records what was implemented on the local `v2` branch. The
implementation baseline is **committed locally** at `97baa06` (HEAD; including
the reviewer-driven fixes, the schema-aware `/usage` SQLite fix, their tests, and
the wlib pin at `f95b73e`). The wlib submodule bump to `5cab3e1` and its pin
references are **staged**; the stable-owner integration and the skill/migration
refinements are **unstaged working-tree changes** — neither is committed or yet
approved. Nothing has been pushed or opened as a PR for `opencode-model-usage`
yet, and final review/QA approval is **pending**. Deployment to the shared
normal root **is in place**, and the user has confirmed the normal-root
`opencode2` runtime test works (§8).

### 13.1 wlib foundation pin

- `model-usage/wlib` submodule updated to the canonical v2 commit
  **`5cab3e142d910f9931fa6d9253f61ed35a554726`**
  (`Restrict export error result to a single Close action`), pushed to the
  submodule remote (`origin/v2`).
- Fetched from the submodule remote `origin/v2`; no package install occurred.
- The v2 host adapter lives at `model-usage/wlib/src/host/v2.ts`
  (`createV2Host`); the deprecated v1 adapter at `.../host/v1.ts`
  (`createV1Host`).

### 13.2 Files added (v2 — supported)

| File | Role |
| --- | --- |
| `model-usage-server.ts` | combined v1/v2 server entry (flat root): default `{ id, server, setup }`; v1 reads `server`, v2 reads `id` + `setup`. |
| `model-usage/server-setup.ts` | v2 server **setup helper**: plain `setup` export, **no default** (so the directory exposes only its `tui` entry); `session.hook("context")`; captures `event.system` (SystemPart[]) and `event.tools` (effective defs). Type-only `@opencode/plugin` import keeps the root v1 file loadable. |
| `model-usage/tui.tsx` | v2 TUI entry: `Plugin.define`, `createV2Host`, `ui.slot("sidebar.content")`, `/usage` + `/analyze` commands. |
| `model-usage/v2/sidebar.tsx` | Sidebar on `context.data` (session model/family/messages) + quota. |
| `model-usage/v2/usage.tsx` | `/usage` dialog ported to the host adapter; SQLite fallback for history. |
| `model-usage/v2/analyze.tsx` | `/analyze` dialog ported to the host adapter; data from `context.data.session.message.list`. |
| `model-usage/v2/backend.ts` | v2 data/backend boundary: historical-usage backend selection (`v2-data` \| `sqlite` \| `none`), SQLite availability validation (regular file + `SQLite format 3` header), and read-only database opening. The TUI never imports `bun:sqlite`. |
| `model-usage/v2/message-adapter.ts` | Pure v2 `SessionMessageInfo` → legacy `{ info, parts }` mapping, including full OpenCode 2.0.27 `PromptFileAttachment` preservation (structured `source` — unknown members included — `data`, `mime`, `name`, `description`, `mention`). |
| `model-usage/v2/sidebar-domain.ts` | Pure sidebar token/cost aggregation + v2 model pricing. |

### 13.3 Files changed (deprecation / decoupling)

- `model-usage.tsx` — v1 entry now builds `createV1Host(api)` and passes it to
  the v1 dialogs; marked deprecated.
- `model-usage-server.ts` — now the combined v1/v2 server entry: keeps the v1
  `ModelUsageServerPlugin` named export and adds a default
  `{ id, server: ModelUsageServerPlugin, setup }`; v1 logic unchanged.
- `model-usage/usage.tsx`, `model-usage/analyze.tsx` — receive a `WlibHost` and
  call the wlib helpers through it (wlib now requires an adapter); still v1.
- `model-usage/helpers/{cost,tokens,compaction,model-tab}.ts` — replaced v1 SDK
  type imports with local structural types (runtime-erased anyway), and widened
  read-only array params; **behaviour unchanged**.
- `model-usage/analyze-domain.ts` — replaced `@opencode-ai/sdk/v2` `Message`/`Part`
  parameter types with local structural `AnalyzeMessage`/`AnalyzePart`; logic
  unchanged so it accepts the v2 adapter output.

### 13.4 v2 server mapping (v1 → v2)

| v1 | v2 |
| --- | --- |
| `experimental.chat.system.transform` (system) + `tool.definition` (tools) | `session.hook("context")` (`event.system`, `event.tools`) |
| `output.system: string[]` | `event.system: SystemPart[]` → `part.text` joined by `"\n"` |
| title-gen guard via string sniff | title uses a **separate** `title` hook; defensive `isTitleGenerator` retained |
| `tool.definition` per-tool accumulation | complete `event.tools` set per request |

Preserved: 32-token drift throttle, 5-min timestamp refresh, compaction (<70%)
replacement, rawText/fragment backfill, 1000/100 FIFO purge, and the unchanged
`system-tokens.json` / `tool-defs.json` paths (so the persona-injector sidecar
contract and the `/analyze` reader keep working). These paths are
`homedir()`-relative: without an isolated sandbox both generations resolve them
to `~/.config/opencode/plugins/model-usage/…` (shared); with the optional
`HOME="$V2_HOME"` sandbox the v2 process resolves
`$V2_HOME/.config/opencode/plugins/model-usage/…` instead. This deploy copies no
user state across roots (path/config isolation, not a filesystem barrier).

### 13.5 Data backend strategy

- **Preferred (v2 data API):** `/analyze` (current-session messages) and the
  sidebar (session/model/cost) read `context.data`.
- **Retained fallback (SQLite):** `/usage` historical per-period, per-model
  aggregation has no v2 API on 2.0.27, so `db.ts`/`cache.ts` remain; the choice
  is isolated in `v2/backend.ts` and degrades to an explicit "unavailable" view.
  The SQLite access is strictly read-only: the plugin never writes to the DB and
  never creates or modifies indexes (see §9).
- **Schema-aware fallback:** `db.ts` detects v1 (`message`/`session`), v2
  (`session_message`/`session_v2`), or hybrid databases. For a hybrid database
  the message-table family and the session-table family are ordered
  **independently** by their own newer `MAX(time_created)`; each reads its newer
  table first and falls back to the older one only when the newer has no rows in
  range (never summing both, and never a row-level merge) — see §9 for the
  partial-migration tradeoff. Unsupported schemas return empty results instead of
  a raw `no such table` error. Assistant usage is read from
  `data.modelID`/`data.providerID` (v1) or `data.model.id`/`data.model.providerID`
  (v2), plus `data.cost` and `data.tokens.*` in both (see §9).
- **Unsupported / unstable (documented, not silently broken):** no v2 historical
  aggregation; `/usage` still depends on OpenCode's SQLite schema, now across
  both the v1 and v2 generations.

### 13.6 v1 compatibility + deployment selection

- v1 and v2 are **separate host implementations** (`ModelUsageServerPlugin` vs
  `setup`, `createV1Host` vs `createV2Host`); each uses exactly one host adapter.
  No runtime branches mix the APIs. They now share **one combined server entry**:
  `model-usage-server.ts` default-exports `{ id, server, setup }`.
- **Shared deploy (both generations)** → the **same normal config root**
  `$HOME/.config/opencode/plugins/`: the flat `model-usage-server.ts` (server) and
  `model-usage.tsx` (v1 TUI, via `tui.json`) plus the `model-usage/` directory
  (v2 TUI `tui.tsx`; shared modules incl. `server-setup.ts`). It must contain **no
  package-root `server.ts`/`index.ts`**, and a package-root server entry must not
  be reintroduced — v2 core discovery admits bare `.ts` children, so
  `model-usage-server.ts` is the v2 server, while a directory with no server
  entry is skipped.
- **Optional isolated data root:** if v2 user data should be separated, deploy the
  same file set under `$V2_HOME/.config/opencode/plugins/` and launch v2 with
  `HOME`/`OPENCODE_CONFIG_DIR`/XDG roots redirected (see `.agents/skills/deploy`).
  This is **not** required for discovery.
- The deprecated v1 entrypoints are not removed yet (cleanup is issue #50).

### 13.7 Unresolved API limitations / blockers

- v2 `Context.data` exposes no config-model accessor; the sidebar resolves the
  active model from session model → `ui.model.current()` → last assistant, which
  may differ from the v1 "global config model wins" ordering.
- v2 has no `session.compaction.completed` event; the sidebar refreshes quota on
  `session.compaction.started` (plus the 5-minute interval).
- v2 plugin directory auto-discovery is confirmed on the shared normal root: the
  user has confirmed the `opencode2` runtime test works (see §8).
- `@opencode/plugin` request/response hook shapes were read from the local
  reference checkout; treat that checkout as authoritative.

### 13.8 Tests

Domain/data logic is pure and testable; the v2 suites are written and run under
`bun:test` (`tests/model-usage/v2/{backend,message-adapter,sidebar-domain}.test.ts`
plus `tests/model-usage/analyze-domain.test.ts`):

- `v2/message-adapter.ts` — assistant tokens/cost/tool mapping, user text/file
  parts (including full `PromptFileAttachment` preservation: lossless structured
  `source`, `data`, `mime`, `name`, `description`, `mention`), compaction →
  synthetic user message with a `compaction` part, unknown message kinds
  skipped, non-object input ignored.
- `v2/sidebar-domain.ts` — `toPricing` (first tier, missing modelID), price-weighted
  vs proportional `splitAssistantCost` (provider+model identity wins, model-only
  fallback preserved), `computeSidebarTotals` peak = max(input+cacheRead),
  `sumSidebarTotals`.
- `v2/backend.ts` — `selectUsageBackend` precedence, `isSqliteAvailable`/
  `sqliteDbStatus` (accepts a real SQLite header; distinguishes `missing` from
  `malformed`/`unreadable`; rejects directories, empty/arbitrary files,
  missing/unreadable paths), and `openUsageDatabase` success/failure handles
  (including header validation inside the open path).
- `server-setup.ts` pure helpers — `isTitleGenerator`, `buildToolDefText`/`buildToolDefSnapshot`,
  `mergeSystemSnapshot` (first write, drift throttle, timestamp refresh, backfill,
  <70% compaction replace, no-op). The helpers now live in
  `model-usage/server-setup.ts`; `tests/model-usage/v2/server-helpers.test.ts`
  must import `@model-usage/server-setup` (its old `@model-usage/server` alias no
  longer resolves — the old `server.ts` path is gone).
- Existing suites must keep passing: `analyze-domain`, `db`, `cache`, `quota`,
  `helpers/*`, and the wlib submodule tests.

### 13.9 Runtime-confirmed v2 API findings (2.0.27)

Resolved against a real `opencode2` runtime; encoded in the v2 code and the
skills (§3.4, §3.6, §3.7, §9, §3.10):

- **Keymap layer `mode`:** omitting `mode` defaults to `base`, dialogs push
  `modal`; wlib sets `mode: "global"` — full detail in §3.4.
- **`dialog.show` may re-run; keep a stable controller owner:** the render
  callback is reactive; the long-lived `createExportController` must be allocated
  once per dialog (not per render). The exact `createOwnedInstance` / `.get()` /
  `.dispose()` lifecycle is in §3.6.
- **Module extension:** under the 2.0.27 local plugin loader, Solid-dependent
  support modules are `.tsx` (the transform covers only `.tsx`/`.jsx`); pure
  helpers and type-only imports stay `.ts` — see §3.10.
- **Theme:** `context.theme` is a `ResolvedTheme`; resolution/skip/RGBA rules are
  in §3.7.
- **Export flow:** `format → destination → result`, PTY-verified in the sandbox
  after the stable-owner fix (real terminal, clipboard + file writes). The result
  popup on success shows the saved path and `← →` focus `Close`/`Open` (`enter`
  activates the focused chip, `o` opens the folder directly); on a file-write
  error only `Close` remains — `enter`/`esc` close and the other registered
  dialog/export keys are consumed so `Open` cannot fire (the result step is
  modal; the keymap only invokes handlers for registered bindings, so unbound
  keys are never dispatched).
- **Sessions view:** text-only selection (matching shipped v1) — the selected
  row's title is `fg={primary}`, the inactive title is `fg`, the stats line is
  always `muted`, and the row has no background/padding; navigation is
  arrow-only.
- **DB schema (2.0.27):** `session_message` / `session_v2`; usage queries are
  schema-aware v1/v2/hybrid, read-only, with per-family/newest-first hybrid
  selection and all-or-nothing fallback when the selected window has no rows —
  including the partial-migration tradeoff (§9).
- **Native `/usage` collision (v2):** OpenCode v2 registers its own Console-limits
  dialog as command id `usage.show` with slash `usage`
  (`packages/tui/src/app.tsx`, `component/usage.tsx`; keybind default `none`).
  `@opentui/keymap` dedupes reachable commands **by id, first registration
  wins**, and the built-in layer registers before plugin `setup()`. Reusing the
  id therefore makes the plugin's binding, palette entry and slash command
  resolve to the native dialog. The v2 plugin now registers
  `model-usage.usage.show` with slash `/model-usage` (id/slash centralised in
  `model-usage/v2/commands.ts`, guarded by
  `tests/model-usage/v2/commands.test.ts`); `Ctrl+Shift+U` is unchanged and v1
  keeps `usage.show` / `/usage` (no native command exists there). Never register
  an un-namespaced id in v2.

### 13.10 Same-root v1/v2 dual-generation entry

The prior layout assumed v1 and v2 were deployed to **separate config roots**
(because v2 core discovery admits bare `.ts` children and rejected the loose v1
`model-usage-server.ts`, which exported no `{ id, setup }` default). That is no
longer the case: both generations now share the **one normal root**
`~/.config/opencode/plugins`, discovered automatically by ordinary `opencode2`.

Source changes:

- **`model-usage-server.ts`** default-exports the combined shape
  `{ id: "model-usage", server: ModelUsageServerPlugin, setup }`. v1 reads
  `server` (`@opencode-ai/plugin` `PluginModule = { id?, server, tui?: never }`);
  v2 reads `id` + `setup` and ignores the extra `server` (the host module schema
  ignores unknown keys). The named `ModelUsageServerPlugin` export is preserved.
- **`model-usage/server.ts` → `model-usage/server-setup.ts`.** The v2
  implementation is now a non-entrypoint helper exporting a plain
  `setup(context)` function with **no default export**. `Host.resolve` therefore
  finds no server entry in the `model-usage/` directory, and
  `ConfigPluginSource.scan` **skips** it — v2 never loads a second server via the
  directory. `model-usage/tui.tsx` remains the directory's (TUI) entry.
- **V1-load safety:** the root `.ts` file evaluates no runtime `@opencode/plugin`
  import. `server-setup.ts` references `@opencode/plugin` only through a
  **type-only** import (`Plugin.Context`), erased at runtime, so OpenCode v1 can
  load the root file and its helper. `Plugin.define`/`Plugin` values are no longer
  imported just to expose `setup`.

Behavior is unchanged: `ModelUsageServerPlugin` and the v2 `setup` body are the
same code as before; only their packaging (default object + helper file) changed.
An isolated `$V2_HOME` is now **optional** and only separates user data.

### 13.11 Known upstream limitation — v2 records $0 cost for OpenCode Go

OpenCode v2 stores the cost the endpoint reports and treats a reported zero as
authoritative (`packages/core/src/session/usage.ts`,
`cost: usage?.cost === undefined ? calculateCost(...) : Money.USD.make(usage.cost)`),
so a subscription provider that reports `0` is recorded as `cost: 0`.

Measured on 2.2.3, session `ses_e726d4816ffeFKS76cCb6Ugzek`
(`opencode-go/gpt-6-luna`): 25 assistant messages, `session_v2.cost = 0`,
`tokens = { input: 72, output: 5532, reasoning: 24261, cache: { read: 1_319_320,
write: 120_199 } }`. The same catalog rates v1 used ($0.10/$0.50 per 1M,
$0.01 cache read, $0.125 cache write) put that turn at ≈**$0.043**, so real
credit was spent while the row says zero. The same database's v1
`message` rows for the same provider/model still carry non-zero cost (e.g.
2026-10-27 `deepseek-v4.1-flash`, 2580 messages, $2.61), which isolates the
change to v2's accounting rather than the Go API or the plugin.

Consequences in the plugin (v2 only, by design — no local estimate is applied):
sidebar "Cost estimation" reads `$0.00`, and `/model-usage` renders the model as
`· free` because `ModelUsage.totalCost` comes straight from the stored rows
(`model-usage/v2/usage.tsx`). v1 continues to show the real figure.

Decision recorded: **do not estimate prices in the plugin.** Displaying a
list-price estimate would invent a number the host did not bill and diverge from
the exported/DB-visible cost. The fix belongs upstream in OpenCode's cost
accounting. Revisit if/when the host falls back to catalog pricing when the
provider reports zero.

Upstream status (checked 2026-10-30): intentional, not a regression. Since
#58562 (2.2.0) the endpoint-reported cost wins and zero is authoritative, so Go
subscription usage records $0; 2.1.4 values were list-price estimates, not
charges. Reports: #59627 (closed `not_planned`), #59634 (open, canonical desktop
duplicate target), #59812 / #60052 (closed as duplicates), #60624 (open, flagged
as a duplicate of #59634). Open feature request #59861 asks for an opt-in
estimate, with PR #59864 adding `experimental.cost-estimate` — display-only, it
does **not** change the recorded cost, so a plugin that reads the database keeps
seeing `0` even after it lands.
