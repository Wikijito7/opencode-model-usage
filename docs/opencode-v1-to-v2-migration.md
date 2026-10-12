# OpenCode v1 → v2 Migration Guide (cross-repository)

> **Status: planning / TL;DR. Not implementation. Deployment is NOT performed.**
> Everything below is local-only preparation. No repo is pushed, deployed,
> installed, or committed as part of this task.

This document is the cross-repository plan for porting the Wokis OpenCode
plugins from the OpenCode **v1** plugin API to OpenCode **v2**. It is the shared
reference for the three migration issues and for the consuming repositories.

---

## 1. Target and coexistence policy

- **Target host:** OpenCode **2.0.27**.
  Local reference checkout:
  `/Users/cristianpc/.local/share/opencode/repos/github.com/anomalyco/opencode`
  (`package.json` → `"version": "2.0.27"`). All v2 API claims in this document
  are grounded in that checkout.
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
| Server module shape | `export const XServerPlugin = async () => ({ …hook map… })` (`model-usage-server.ts:126`, `persona-injector-server.ts:75`) | `export default Plugin.define({ id, setup })` |
| Entry-file resolution | Convention-based single entry | `Host.resolve` resolves distinct **`server`**, **`tui`**, **`rpc`** subpaths (`reference/packages/plugin/src/host.ts`) |
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
| Inline key binding object `{ key, cmd, desc }` | `bind` on the command + the command **ID** listed in layer `bindings: readonly string[]` |
| — | New: `enabled`, `suggested`, `priority`, `mode`, `target`, `keymap.dispatch(id)`, `keymap.shortcuts(id)` |

Field mapping is confirmed by issue #4 (wlib).

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

### 3.7 Theme

| v1 | v2 |
| --- | --- |
| `api.theme.current` with drifting property names (`text`/`foreground`, `textMuted`/`muted`, `error`/`red`), normalized by `wlib/src/core/theme.ts` `resolveThemeColors` | `ctx.theme` is a typed **`ResolvedTheme`** with semantic tokens (`text.base`, `text.muted`, `background.base`, `border.base`, `scrollbar.base`, `diff.*`, `syntax.*`, …; `reference/packages/theme/src/tui/types.ts`) |
| RGBA values passed through as opaque objects | Keep **RGBA pass-through**, never string-coerce (issue #4) |

### 3.8 Storage

| v1 | v2 |
| --- | --- |
| Plugin-owned JSON files (`system-tokens.json`, `tool-defs.json`, `.usage-cache.json`), `model-usage-server.ts:9-17` | TUI: `ctx.storage.store(key, { initial })` (durable) and `ctx.storage.memory(key, { initial })` (ephemeral); server: `ctx.storage.get/set/remove/scan` (`.../tui/context.ts`, `.../effect/storage.ts`) |
| Cross-plugin sidecar `wlib/src/core/system.ts` (`~/.config/opencode/plugins/persona-injector/system-snapshots.json`) | v2 storage is **plugin-scoped** and does not automatically replace cross-plugin sharing — explicit design decision needed (issue #4; §11) |

### 3.9 Data and event naming

| v1 | v2 |
| --- | --- |
| `api.state.config`, `api.state.provider`, `api.state.session.messages(id)` (`model-usage/sidebar.tsx`) | `ctx.data.location.model/provider`, `ctx.data.session.message.list/get`, `ctx.data.session.status/cost`, etc. |
| `api.event` / ad-hoc event listeners | `ctx.data.on(type, handler)` / `ctx.data.listen(handler)` |
| Flat/legacy event names | Namespaced v2 events: `session.created`, `session.agent.selected`, `session.model.selected`, `session.compacted`, `session.status`, `session.idle`, `config.updated`, `project.updated`, `plugin.updated`, `server.connected`, `global.disposed`, `tui.*` (`reference/packages/schema/src/*`, assembled by `reference/packages/protocol/src/groups/event.ts` from `EventManifest.ServerDefinitions`). Validate the exact set against `@opencode/schema/event-manifest`. |

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

- `model-usage-server.ts` — `Plugin.define`; `session.hook` + `tool.hook`; snapshot ordering decision.
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

### 5.1 `tui.json` → `cli.json`

| v1 | v2 |
| --- | --- |
| `~/.config/opencode/tui.json` → `{ "plugin": [ "./plugins/persona-injector.tsx" ] }` (persona README “Deployment”; also `plugin_enabled`) | `~/.config/opencode/cli.json` → `{ "$schema": "https://opencode.ai/v2/cli.json", "plugins": [ "./plugins/persona-injector.tsx" ] }` |
| `opencode.json` plugin registration | `plugins` field (same `ConfigPlugin.Plugins` array) |

- Field key is **`plugin` (v1) → `plugins` (v2)**.
- v2 plugin entry: `string | { package: string, options?: Record<string, unknown> }`
  (`reference/packages/schema/src/config/plugin.ts`,
  `reference/packages/tui/src/config/index.tsx`).
- OpenCode ships an automatic migration of `tui.json` + legacy `kv.json` into
  `cli.json` (`reference/packages/cli/src/config/migrate.ts`,
  `migrateV1`), including `plugin` → `plugins` and `plugin_enabled`.
  `SchemaURL` is `https://opencode.ai/v2/cli.json`
  (`reference/packages/cli/src/config/schema.ts`).

### 5.2 Discovery / layout

- Local plugin directories are discovered automatically from
  `<configDir>/plugins/` and project `.opencode/plugins/`; **each subdirectory
  is one plugin** (`reference/packages/tui/src/plugin/discovery.ts`,
  `localPluginDirectories` + `discoverPluginTargets`).
- A plugin target is resolved by `Host.resolve`, which looks for the
  **`server`**, **`tui`**, and **`rpc`** subpaths / entry files
  (`reference/packages/plugin/src/host.ts`).
- Packages listed in config `plugins` are installed/resolved via npm; only those
  with a resolved `tui` entrypoint are surfaced by `opencode plugin list`
  (`reference/packages/cli/src/commands/handlers/plugin/list.ts`).
- **Auto-discovered:** directory-style plugins under `<configDir>/plugins/`.
  **Must be declared:** external npm packages (and enable/disable/order
  directives).
- **Deployment-layout change:** v1 deployed loose entry files
  (`~/.config/opencode/plugins/model-usage.tsx`, `…-server.ts`, `…/model-usage/`)
  and registered one path in `tui.json`. v2 expects a discoverable
  plugin **directory** with resolved server/tui entrypoints. The exact v2
  on-disk layout must be confirmed against a real `opencode2` install (§11).

---

## 6. Dependency / lockfile reconciliation

**Why `package.json`, `bun.lock`/`package-lock.json`, and `node_modules` can
disagree:**

- **wlib is a git submodule, not an npm dependency.** The real version is the
  gitlink commit recorded by the parent repo (`.gitmodules` + index), not
  anything in a lockfile. Current pin in both consumers:
  `545fe7c736592974a377ebd94711f3b14c63c09d` (`origin/HEAD`, i.e. `main`) — **not
  the v2 commit yet**.
- **No tracked `package.json` or lockfile exists** in any of the three repos on
  the `v2` branch. The runtime API (`@opencode-ai/plugin@1.4.1` per issue #34) is
  supplied by the host, so nothing anchors it locally.
- **`node_modules/` is gitignored** (`.gitignore` in all three repos), so a
  stale installed copy of the plugin API or an old `cp -r` of `wlib` can sit
  beside a newer submodule pin and silently disagree.
- A lockfile reflects whatever was last installed **locally**; it does not
  follow `git submodule update`.

**Reconciliation checklist:**

- [ ] After wlib v2 lands, bump the submodule in persona-injector and
      model-usage to a v2-containing commit (issue #4: only after v2 wlib tests
      pass).
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
- **Shape of the adapter:** separate v1 and v2 entrypoints/exports so the host
  picks one; no runtime branching that mixes both API surfaces. Removal is
  gated on “v2 adoption established”.

---

## 8. Deployment and verification checklist

> **Deployment is explicitly NOT performed as part of this task.** This section
> is the future runbook.

- [ ] wlib v2 implementation complete; `bun test` green; typecheck green.
- [ ] persona-injector v2 complete; ports `wlib`; tests + typecheck green.
- [ ] model-usage v2 complete; ports `wlib`; tests + typecheck green.
- [ ] Submodule consumers bumped to the v2 wlib commit.
- [ ] `tui.json` → `cli.json` `plugins` migration verified.
- [ ] Plugin discovery layout verified under a real `opencode2` install.
- [ ] Sync via the `deploy` skill (entry points + `rsync` mirror; tests excluded;
      runtime artifacts preserved). **Not yet executed.**
- [ ] Runtime verification in `opencode2`: server load, `/persona`, `/usage`,
      `/analyze`, sidebar + prompt indicators, dialogs, exports, quota.
- [ ] No v1 plugin APIs remain in productive code or `wlib`.

---

## 9. model-usage SQLite / data migration strategy and fallback

**Current state:** `model-usage/db.ts` opens OpenCode's SQLite database directly
with `bun:sqlite` (read-only) and queries `session` / message tables;
`model-usage/cache.ts` keeps persistent month/week/day caches; the server writes
`system-tokens.json` and `tool-defs.json`.

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

- [ ] Map each `db.ts` query to a v2 `ctx.data`/client source; list gaps.
- [ ] Add fallback + error surface for unavailable history.
- [ ] Decide `ctx.storage` vs retained JSON for caches.
- [ ] Keep domain layer free of SQLite/host imports.

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
- **Runtime installation / layout:** the v2 plugin directory layout and
  auto-discovery behavior need verification on a live `opencode2`; issue #47
  lists `opencode.json`, `cli.json`, or `plugins/tui/` discovery as candidates.
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
- **Submodule pin** currently points at `main`, not a v2 commit (§6).

---

## 12. Actionable summary

- [ ] Confirm open questions in §11 with the Lead Coordinator before coding.
- [ ] wlib v2 (#4): port core/command, keys, theme, ui/dialog,
      export-controller; update tests; update MIGRATION.md/README.
- [ ] persona-injector v2 (#34): `Plugin.define`, v2 hooks, slots, keymap,
      dialog/toast, `cli.json`.
- [ ] model-usage v2 (#47): `Plugin.define`, v2 hooks, `ctx.ui.slot`,
      `ctx.keymap.layer`, `ctx.data`, data-layer abstraction, config.
- [ ] notifications migration (repo TBD).
- [ ] Removal issues #5 / #35 / #50 after v2 adoption.
- [ ] Deployment + live `opencode2` verification (NOT performed yet).

---

## 13. Implementation record — opencode-model-usage (local, uncommitted)

This section records what was actually implemented on the local `v2` branch.
Nothing is committed, pushed, deployed, or installed.

### 13.1 wlib foundation pin

- `model-usage/wlib` submodule updated to the canonical v2 foundation commit
  **`e91baf2877bf19c27f70a1c817f1348ccd3f5353`**
  (`Add v2 host adapter and migrate wlib helpers onto WlibHost`).
- Fetched from the local `opencode-wlib` checkout (the commit is not on the
  submodule's remote yet), so no network install occurred.
- The v2 host adapter lives at `model-usage/wlib/src/host/v2.ts`
  (`createV2Host`); the deprecated v1 adapter at `.../host/v1.ts`
  (`createV1Host`).

### 13.2 Files added (v2 — supported)

| File | Role |
| --- | --- |
| `model-usage/server.ts` | v2 server entry: `Plugin.define({ id, setup })`, `session.hook("context")`; captures `event.system` (SystemPart[]) and `event.tools` (effective defs). |
| `model-usage/tui.tsx` | v2 TUI entry: `Plugin.define`, `createV2Host`, `ui.slot("sidebar.content")`, `/usage` + `/analyze` commands. |
| `model-usage/v2/sidebar.tsx` | Sidebar on `context.data` (session model/family/messages) + quota. |
| `model-usage/v2/usage.tsx` | `/usage` dialog ported to the host adapter; SQLite fallback for history. |
| `model-usage/v2/analyze.tsx` | `/analyze` dialog ported to the host adapter; data from `context.data.session.message.list`. |
| `model-usage/v2/backend.ts` | Pure historical-usage backend selection (`v2-data` \| `sqlite` \| `none`) + `isSqliteAvailable`. |
| `model-usage/v2/message-adapter.ts` | Pure v2 `SessionMessageInfo` → legacy `{ info, parts }` mapping. |
| `model-usage/v2/sidebar-domain.ts` | Pure sidebar token/cost aggregation + v2 model pricing. |

### 13.3 Files changed (deprecation / decoupling)

- `model-usage.tsx` — v1 entry now builds `createV1Host(api)` and passes it to
  the v1 dialogs; marked deprecated.
- `model-usage-server.ts` — deprecated header added; logic unchanged.
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
contract and the `/analyze` reader keep working).

### 13.5 Data backend strategy

- **Preferred (v2 data API):** `/analyze` (current-session messages) and the
  sidebar (session/model/cost) read `context.data`.
- **Retained fallback (SQLite):** `/usage` historical per-period, per-model
  aggregation has no v2 API on 2.0.27, so `db.ts`/`cache.ts` remain; the choice
  is isolated in `v2/backend.ts` and degrades to an explicit "unavailable" view.
- **Unsupported / unstable (documented, not silently broken):** no v2 historical
  aggregation; `/usage` depends on OpenCode's SQLite schema
  (`message.data` JSON `modelID`/`providerID`/`cost`/`tokens`, `session` table).

### 13.6 v1 compatibility + deployment selection

- v1 and v2 are **separate entrypoints** and **separate UI modules**; each uses
  exactly one host adapter. No runtime branches mix the APIs.
- v2 deploy: `model-usage/` → `~/.config/opencode/plugins/model-usage/`; OpenCode
  2.0.27 discovery resolves `server.ts` + `tui.tsx`. Loose v1 files are not
  directories and are never auto-discovered.
- v1 deploy: legacy loose files registered via `tui.json`.
- The deprecated v1 entrypoints are not removed yet (cleanup is issue #50).

### 13.7 Unresolved API limitations / blockers

- v2 `Context.data` exposes no config-model accessor; the sidebar resolves the
  active model from session model → `ui.model.current()` → last assistant, which
  may differ from the v1 "global config model wins" ordering.
- v2 has no `session.compaction.completed` event; the sidebar refreshes quota on
  `session.compaction.started` (plus the 5-minute interval).
- v2 plugin directory auto-discovery still needs verification against a live
  `opencode2` install (see §8).
- `@opencode/plugin` request/response hook shapes were read from the local
  2.0.27 reference checkout; treat that checkout as authoritative.

### 13.8 Required tests (NOT written in this task)

Domain/data logic is pure and testable; the following tests are required:

- `v2/message-adapter.ts` — assistant tokens/cost/tool mapping, user text/file
  parts, compaction → synthetic user message with a `compaction` part, unknown
  message kinds skipped, non-object input ignored.
- `v2/sidebar-domain.ts` — `toPricing` (first tier, missing modelID), price-weighted
  vs proportional `splitAssistantCost`, `computeSidebarTotals` peak = max(input+cacheRead),
  `sumSidebarTotals`.
- `v2/backend.ts` — `selectUsageBackend` precedence and `isSqliteAvailable`
  missing/error paths.
- `server.ts` pure helpers — `isTitleGenerator`, `buildToolDefText`/`buildToolDefSnapshot`,
  `mergeSystemSnapshot` (first write, drift throttle, timestamp refresh, backfill,
  <70% compaction replace, no-op).
- Existing suites must keep passing: `analyze-domain`, `db`, `cache`, `quota`,
  `helpers/*`, and the wlib submodule tests.
