# Model Usage

OpenCode plugin that tracks and visualises model usage, token consumption, and costs across sessions.

## OpenCode v2 (2.0.27) — supported path

The supported implementation targets **OpenCode 2.0.27** (`@opencode/plugin`).
Both generations share **one normal-root layout**:

| Concern | v2 (2.0.27, supported) | v1 (deprecated) |
|---|---|---|
| Server entry | `model-usage-server.ts` — **shared combined default** `{ id, server, setup }`; v2 reads `id` + `setup` | same file — v1 reads `server` |
| TUI entry | `model-usage/tui.tsx` — `Plugin.define({ id, setup })`, `createV2Host` (the `model-usage/` directory's only entry) | `model-usage.tsx` — `TuiPlugin` + `createV1Host` |
| Dialogs | `model-usage/v2/{usage,analyze,sidebar}.tsx` | `model-usage/{usage,analyze,sidebar}.tsx` |
| Host adapter | `createV2Host` (`wlib/src/host/v2`) | `createV1Host` (`wlib/src/host/v1`) |

**Never mix the two host APIs in one adapter.** v2 modules import only the v2
adapter and v2 APIs; v1 modules import only the v1 adapter and the raw
`TuiPluginApi`.

### Deployment layout

Both generations deploy to the **same normal config root**,
`$HOME/.config/opencode/plugins/`:

- **Shared server entry (root file):** `plugins/model-usage-server.ts` exports a
  single default object `{ id: "model-usage", server, setup }`. OpenCode v1 reads
  `server`; OpenCode 2.0.27 reads `id` + `setup` and ignores the extra `server`
  key (its module schema ignores unknown keys). One file serves both.
- **v2 TUI entry (package directory):** `plugins/model-usage/tui.tsx`, resolved
  as the directory's `tui` entry. The `model-usage/` directory has **no
  package-root server** (`server.ts` / `index.ts`), so v2 core discovery skips it
  and never loads a second server — the v1/v2 server is the shared root file.
- **v1 TUI entry (root file):** `plugins/model-usage.tsx`, registered in
  `tui.json` (`{ "plugin": ["./plugins/model-usage.tsx"] }`). v2 TUI discovery
  admits only directories, so this bare file is never loaded by v2.

```
$HOME/.config/opencode/plugins/      # the one normal root both generations use
  model-usage-server.ts              # shared dual-gen server entry { id, server, setup }
  model-usage.tsx                    # v1 TUI entry (registered via tui.json)
  model-usage/
    tui.tsx                          # v2 TUI entry (directory `tui` resolution)
    server-setup.ts                  # v2 setup helper, imported by model-usage-server.ts
    v2/  helpers/  wlib/ …           # shared modules
```

A separate HOME is **not** required: ordinary `opencode2` discovers the plugin
from the same normal `~/.config/opencode/plugins` root. An isolated `$V2_HOME`
is an **optional** convenience for keeping v2's *data* (SQLite DB, auth, caches,
exports) separate from v1 — it is **not** needed for plugin discovery or
compatibility. Enabling it, however, also moves the discovery root with it
(the launcher redirects `HOME`/`OPENCODE_CONFIG_DIR`), so the shared package
copy is no longer visible under the sandbox: you must deploy the same file set
under the sandbox root (`$V2_HOME/.config/opencode/plugins/`) as well. See
`.agents/skills/deploy` for the cp/rsync mapping and exclusions (**this
deployment** copies no credentials or database files).

> **Isolation is path/config only, not an OS security boundary.** If you opt into
> an isolated `$V2_HOME` (redirecting `HOME`), every `homedir()`-relative path the
> plugin resolves lands under the sandbox, but plugins and the process can still
> read/write absolute paths, follow symlinks, and reach a shared mount — a
> symlinked or bind-mounted `$V2_HOME` can still expose v1 files. The documented
> procedure copies no auth/DB into the sandbox; that is its guarantee, not that v2
> can never touch v1 state by other means.

**Optional isolated data root (v2).** To keep v2's *user state* apart from v1,
launch the v2 binary with the config surface redirected:

```bash
# Capture the normal HOME *before* redirecting it and resolve symlinks, so the
# guard below compares real directories (e.g. /var vs /private/var).
REAL_HOME="$(cd "$HOME" && pwd -P)"
export V2_HOME="${OPENCODE_V2_HOME:-$HOME/.opencode-v2}"

# Guard: V2_HOME must be set and must NOT resolve to the normal HOME.
: "${V2_HOME:?V2_HOME must be set to an isolated home distinct from \$HOME}"
if [ "$(cd "$V2_HOME" 2>/dev/null && pwd -P)" = "$REAL_HOME" ]; then
  echo "Refusing to launch v2: V2_HOME resolves to the normal HOME ($HOME)." >&2
  echo "Set V2_HOME to an isolated root, e.g. \$HOME/.opencode-v2." >&2
  exit 1
fi

export HOME="$V2_HOME"
export OPENCODE_CONFIG_DIR="$V2_HOME/.config/opencode"
export XDG_CONFIG_HOME="$V2_HOME/.config"
export XDG_DATA_HOME="$V2_HOME/.local/share"
export XDG_CACHE_HOME="$V2_HOME/.cache"
export XDG_STATE_HOME="$V2_HOME/.local/state"
opencode2   # the v2 binary
```

Ordinary `opencode2` (without this launcher) discovers the plugin from the
normal shared root `~/.config/opencode/plugins`, so the sandbox is **not
required for compatibility or discovery** — it is an **optional** opt-in for
data separation only. If you *do* enable it, note that it redirects the
discovery root too: because the launcher sets `HOME` **and**
`OPENCODE_CONFIG_DIR`, v2 no longer looks in the shared normal root, so the
plugin package must have its own copy under the sandbox root
(`$V2_HOME/.config/opencode/plugins/` — see `.agents/skills/deploy`) or the
sandbox will not find it. It therefore changes which user-state paths resolve
*and* which root is scanned. Because `HOME` itself is redirected, every path the
plugin resolves through `homedir()` lands under `$V2_HOME`; the launcher captures
the normal `$HOME` first and aborts if `$V2_HOME` is unset or resolves (symlinks
included) to the same directory.

**Home-relative paths — shared normal root vs optional sandbox.** These are the
plugin's user-state paths. Without isolation both generations resolve them under
the same real `$HOME` (so v1 and v2 **share** the same data). With the optional
sandbox the second column applies to the v2 process instead. (Path resolution
only — a symlinked/shared `$V2_HOME` can still alias them.)

| User state | normal root, `HOME` = real `$HOME` | optional sandbox, `HOME` = `$V2_HOME` |
|---|---|---|
| opencode-go credentials (`auth.json`) | `~/.local/share/opencode/auth.json` | `$V2_HOME/.local/share/opencode/auth.json` |
| OpenCode SQLite DB (`/usage` history) | `~/.local/share/opencode/opencode.db` | `$V2_HOME/.local/share/opencode/opencode.db` |
| Server snapshots (`system-tokens.json`, `tool-defs.json`) | `~/.config/opencode/plugins/model-usage/…` | `$V2_HOME/.config/opencode/plugins/model-usage/…` |
| Persistent cache (`.usage-cache.json`) | `~/.config/opencode/plugins/model-usage/.usage-cache.json` | `$V2_HOME/.config/opencode/plugins/model-usage/.usage-cache.json` |
| Export dir (default) | `~/.config/opencode/export` | `$V2_HOME/.config/opencode/export` |

**The deploy copies nothing into a sandbox.** It ships only the plugin source —
never credentials or database files (see the `.agents/skills/deploy` exclusions).
A fresh isolated `$V2_HOME` therefore starts with **no `auth.json` and no SQLite
DB**: `/usage` shows its explicit empty state until a database exists there, and
the opencode-go quota reads the sandbox `auth.json` (absent until that sandbox is
authenticated itself). To authenticate a sandbox, use any supported alternative —
`OPENCODE_GO_API_KEY`, an `opencode-go` `"type": "api"` entry in the sandbox
`auth.json`, or the legacy cookie + workspace ID — see
[Requirements](#requirements). The plugin only ever reads these files; it never
writes auth or creates the database.

There is no root-selection step: both generations read the same shared root; the
runtime picks its own entrypoints (v1 `server` vs v2 `id`+`setup`; v1 `tui.json`
vs v2 directory `tui`).

### Data backend strategy

The v2 data/client API is current-session scoped and is the **preferred** source
where it can answer the query:

- `/analyze` reads session messages from `context.data.session.message.list` and
  maps them (`model-usage/v2/message-adapter.ts`) into the pure `analyze-domain`.
- The sidebar aggregates session token/cost from `context.data` via the pure
  `model-usage/v2/sidebar-domain.ts`.

It does **not** expose historical per-model usage across arbitrary periods, which
`/usage` needs. That feature **retains a read-only SQLite fallback**
(`model-usage/db.ts`, selected by `model-usage/v2/backend.ts`) with explicit
degradation when no database is present. The plugin opens OpenCode's database
`readonly: true` on every path (v1 and v2) — it never writes, and it **never
creates or modifies indexes**. Any index already present in an installed DB is
simply used; queries remain correct without one.

The query layer is **schema-aware**. It detects the historical schema from the
tables present (v1 `message`/`session`; v2 `session_message`/`session_v2`, whose
assistant usage lives in `data.model.id`, `data.model.providerID`, `data.cost`,
`data.tokens.*`). A pure-v1, pure-v2, or hybrid database (both generations, e.g.
after a v1→v2 migration leaves the old tables behind) all work. Source selection
is **per table family and independent**: the message-table family and the
session-table family are each ordered by their own newer `MAX(time_created)`
(ties prefer v2), and each reads its newer table first, falling back to the older
one only when the newer table has no rows in the requested window — so the two
generations are never summed and a hybrid DB is never double-counted. The two
family choices are not coupled, so a hybrid DB may read v2 messages with v1
sessions (or vice versa). Note the tradeoff: in a **partially migrated** database
the fallback is all-or-nothing, so older-generation rows for a window can be
omitted whenever the newer source has any matching rows. A database with an
unrecognised schema degrades to an empty view rather than a raw `no such table`
error. See `docs/opencode-v1-to-v2-migration.md`.

## Features

### Server (`model-usage-server.ts` — shared v1/v2; `model-usage/server-setup.ts` — v2 setup)
The flat root `model-usage-server.ts` default-exports `{ id, server, setup }`: OpenCode v1 reads `server`, OpenCode 2.0.27 reads `id` + `setup` and ignores `server`. The v2 setup lives in the non-entrypoint `model-usage/server-setup.ts` (plain `setup` export, no default), so the `model-usage/` directory exposes only its `tui.tsx` entry and v2 never loads a second server.

On OpenCode 2.0.27 the server hooks `session.hook("context")`, which fires for the primary agent loop immediately before provider dispatch and carries **both** the assembled system parts (`event.system: SystemPart[]`) and the effective tool definitions (`event.tools`). This captures a pre-mutation server snapshot of the system prompt; the persona-injector sidecar can provide the final override. Title generation uses a separate hook, so it is structurally excluded (with a defensive title-generator guard retained). Both sequences re-measure on each qualifying call (keeps the latest — the system can grow mid-session as refs/MCP/skills load), though system snapshots may skip persistence when drift is ≤32 tokens; per-fragment char/4 breakdowns plus the raw text persist to `system-tokens.json` and `tool-defs.json` (FIFO-capped at 1000 entries). Used by `/analyze` for the System Breakdown and Tool Defs rows.

The v1 server (`ModelUsageServerPlugin`, the same file's `server` property) uses the v1 `experimental.chat.system.transform` + `tool.definition` hooks.

### Sidebar
Cost estimation (price-weighted input/output split from API) plus provider-specific quota:
- **GitHub Copilot** — premium request counting + monthly quota from GitHub API
- **opencode-go** — rolling (5h), weekly, and monthly quota from the OpenCode Go usage API (`GET https://opencode.ai/zen/go/v1/usage`); falls back to scraping the workspace Go page when no Bearer key is available

When the active provider exposes a monthly quota, the sidebar also projects month-end usage: `X% projected by <month end>` once at least 3 days of the month have elapsed (before that, `calculating projection...`).

### `/usage` command (`Ctrl+Shift+U`)
Per-model token and cost breakdown for any month, week, or day, queried from OpenCode's SQLite database. Progress bars show each model's share of the period; `o` cycles the sort between tokens, cost, and price. The total line shows the percent difference vs the previous period, and the current month shows an "on pace: $X by end of month" projection. Session/message counts for the period appear in the header when available.

| Key | Action |
|---|---|
| `←` / `→` | Navigate periods |
| `t` | Jump back to current period |
| `m` | Toggle mode (month ↔ week ↔ day) |
| `o` | Cycle sort (tokens → cost → price) |
| `g` | Toggle trend series (last 12 months/weeks or 30 days, with peak weekday) |
| `e` | Export — format → destination (Clipboard / File); Markdown / CSV / JSON / plain text |
| `r` | Reload current data |
| `↑` / `↓` | Scroll |
| `PgUp` / `PgDn` | Page scroll |
| `h` | Toggle help |
| `esc` | Close |

### `/analyze` command (`Ctrl+Shift+A`)
Per-session context token breakdown for the open session. Categorises every message part into SYSTEM / USER / ASSISTANT / TOOLS / REASONING.

**Tabbed layout** — `←` / `→` to switch tabs (arrow-only; `h` opens help):
- **Context** — all categories with percentage bars and session total
- **Per-Tool** — tool-level token breakdown (output + call arguments) grouped by tool name
- **System** — per-fragment system token breakdown (agent prompt, instructions, environment, skills, MCP, refs, plugin-injected persona…). Fragments are split from the assembled prompt via `Instructions from:` markers, XML section tags, and plugin injection boundaries. Tab only appears when ≥2 fragments exist
- **Tool Defs** — per-tool definition token breakdown from server-captured fragments, with telemetry/residual-based estimates where applicable (per-session attribution can be approximate under concurrent/subagent calls). Tab only appears when ≥2 tool defs exist
- **Models** — per-model breakdown (input/output/cache/tokens/cost) with message counts. Shown whenever a model has usage — single-model sessions still display the model's token/cache/cost info
- **Extra Info** — Top Contributors, Session cost, Compaction events, Model switches, Hotspot messages (expandable via digit keys 1-5 or mouse click)

**System token sources:**
1. **Server snapshot / sidecar** — primary raw system text from `system-tokens.json` (persona-injector sidecar override wins when present)
2. **Telemetry** — fallback reconstituted from API telemetry when the server snapshot is unavailable
3. **Baseline DB** — baseline token-count input from the V2 native runner (cross-check only; currently not the resolved exact assembled text)
4. No data — SYSTEM omitted

**Additional controls:**

| Key | Action |
|---|---|
| `v` on System / Tool Defs | Toggle raw text visor (up to 50k chars) |
| `c` on System / Tool Defs | Copy the raw text to clipboard (while the visor is open) |
| `r` | Reload / recalculate |
| `↑` / `↓` | Scroll |
| `PgUp` / `PgDn` | Page scroll |
| `e` | Export — format → destination (Clipboard / File); Markdown / JSON / plain text — no CSV |
| `h` | Toggle help |
| `esc` | Close |
| `1`-`5` on Extra Info | Expand hotspot messages |

All exports choose a **format** then a **destination** (`Clipboard` / `File`): `enter` on a format shows the destination list. Choosing `Clipboard` copies the export and closes the popup with the `copied!` flash **only when `writeClipboard` succeeds**; if the clipboard write fails the popup stays open on the destination step with no flash and no result popup. Choosing `File` writes the file and opens a result popup reporting the outcome — on success it shows the saved path with `← →` focusing `Close`/`Open` (`enter` activates the focused chip, `o` opens the folder), and on a file-write error only `Close` remains (`enter`/`esc` close, other keys do nothing). Exports include the full raw system prompt and raw tool-definition text, preserved in full (not truncated). Background auto-poll every 60s keeps the dialog in sync.

## Requirements

No single credential is required, and the plugin can run without any of them
(the affected quota simply shows unavailable). What each feature needs:

- **GitHub Copilot quota** uses `GITHUB_TOKEN`.
- **opencode-go quota** uses the first available credential, in priority order —
  any one of these is sufficient:
  - `OPENCODE_GO_API_KEY` — Console API key, sent as `Authorization: Bearer` to the usage API (preferred)
  - `~/.local/share/opencode/auth.json` — `opencode-go` entry
    with `type: "api"` (used when the env var is unset). The path is
    `homedir()`-relative: without isolation both generations read the normal
    `~/.local/share/opencode/auth.json`; under the **optional** v2 sandbox
    (`HOME="$V2_HOME"`) it is the separate `$V2_HOME/.local/share/opencode/auth.json`.
    This deployment copies no credentials across, so a fresh sandbox needs one of
    these alternatives — `OPENCODE_GO_API_KEY`, a sandbox `auth.json` `opencode-go`
    entry, or the cookie below — until it has been authenticated itself
  - `OPENCODE_GO_AUTH_COOKIE` — legacy browser auth cookie; only used when no Bearer key is available, and additionally requires `OPENCODE_GO_WORKSPACE_ID` to scrape the workspace Go page. Accepts either a value-only auth cookie or a full `Cookie` header.

## Debug

Set `OPENCODE_COPILOT_DEBUG=true` to enable plugin debug logs (written to `model-usage/logs/`). Set `OPENCODE_WLIB_DEBUG=true` to enable logging from the shared `wlib` helpers.

## Structure

```
model-usage/                          # shared plugin directory (deploy → $HOME/.config/opencode/plugins/model-usage/; see .agents/skills/deploy)
├── tui.tsx                           # v2 TUI entry (Plugin.define + createV2Host + slots/commands)
├── server-setup.ts                   # v2 server setup helper (plain `setup` export; imported by the root server file)
├── v2/                               # v2 TUI implementation (host API 2.0.27)
│   ├── sidebar.tsx                   # Usage sidebar widget (context.data)
│   ├── usage.tsx                     # /usage dialog
│   ├── analyze.tsx                   # /analyze dialog
│   ├── backend.ts                    # Historical-usage backend strategy (pure)
│   ├── message-adapter.ts            # v2 SessionMessageInfo → legacy shape (pure)
│   └── sidebar-domain.ts             # Sidebar token/cost aggregation (pure)
│
├── analyze-domain.ts                 # Per-session message analysis (pure)
├── analyze.tsx                       # DEPRECATED v1 /analyze dialog
├── cache.ts                          # Persistent month/week/day cache
├── db.ts                             # SQLite query layer (retained historical fallback)
├── quota.ts                          # Copilot + opencode-go quota
├── sidebar.tsx                       # DEPRECATED v1 sidebar widget
├── types.ts                          # Type definitions
├── usage-domain.ts                   # Usage data domain logic (pure)
├── usage.tsx                         # DEPRECATED v1 /usage dialog
├── version.ts                        # Plugin name + version
├── helpers/                          # Pure utility modules
│   ├── compaction.ts                 # Compaction delta estimation
│   ├── cost.ts                       # Cost splitting / cache-hit rate
│   ├── dates.ts                      # Date utilities
│   ├── debug.ts                      # Debug logging
│   ├── export/                       # Export serializers
│   │   ├── usage.ts                  # /usage export (Markdown/CSV/JSON/text)
│   │   └── analyze.ts                # /analyze export (Markdown/JSON/text)
│   ├── format.ts                     # Token formatting
│   ├── fragments.ts                  # System prompt fragment splitting
│   ├── hotspots.ts                   # Unusually large message detection
│   ├── model-tab.ts                  # Model comparison tab
│   ├── model.ts                      # Model definitions
│   ├── models.ts                     # Per-model usage breakdown
│   ├── projection.ts                 # Month-end cost projection
│   └── tokens.ts                     # Token estimation (char/4)
└── wlib/                             # Shared helper submodule (git submodule)
    └── src/
        ├── core/                     # Pure + host-agnostic helpers (system, clipboard, scroll, keys, theme, log, reload, command, dialog-fit, file, open-folder, export, export-state, help)
        ├── ui/                       # SolidJS/TUI components (dialog, copied-flash, export-controller, export-overlay, export-result-overlay, help-overlay)
        └── host/                     # Host adapters: types.ts, v1.ts (deprecated), v2.ts (production)

model-usage.tsx                       # v1 TUI entry point (registered via tui.json)
model-usage-server.ts                 # shared v1/v2 server entry point (default { id, server, setup })
tests/                                # Unit tests (tests/model-usage/*.test.ts)
```

See `docs/opencode-v1-to-v2-migration.md` for the full migration record and
`.agents/skills/plugin-development` for entrypoint/hook rules.

