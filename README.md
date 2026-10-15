# Model Usage

OpenCode plugin that tracks and visualises model usage, token consumption, and costs across sessions.

## OpenCode v2 (2.0.27) — supported path

The supported implementation targets **OpenCode 2.0.27** (`@opencode/plugin`) and
lives in the `model-usage/` plugin directory:

| Concern | v2 (supported) | v1 (deprecated) |
|---|---|---|
| Server entry | `model-usage/server.ts` — `Plugin.define({ id, setup })`, `session.hook("context")` | `model-usage-server.ts` — hook map (`experimental.chat.system.transform`, `tool.definition`) |
| TUI entry | `model-usage/tui.tsx` — `Plugin.define({ id, setup })`, `createV2Host` | `model-usage.tsx` — `TuiPlugin` + `createV1Host` |
| Dialogs | `model-usage/v2/{usage,analyze,sidebar}.tsx` | `model-usage/{usage,analyze,sidebar}.tsx` |
| Host adapter | `createV2Host` (`wlib/src/host/v2`) | `createV1Host` (`wlib/src/host/v1`) |

**Never mix the two host APIs in one adapter.** v2 modules import only the v2
adapter and v2 APIs; v1 modules import only the v1 adapter and the raw
`TuiPluginApi`.

### Deployment layout (selection)

- **v2:** deploy the `model-usage/` directory to
  `~/.config/opencode/plugins/model-usage/`. OpenCode 2.0.27 auto-discovers each
  subdirectory of `plugins/` as one plugin and resolves its `server` and `tui`
  entrypoints — so `model-usage/server.ts` and `model-usage/tui.tsx` are loaded.
  Loose files (including the deprecated `model-usage.tsx` /
  `model-usage-server.ts`) and the `v2/` / `v1`-era source modules are **not**
  entrypoints and are never auto-loaded.
- **v1:** register `~/.config/opencode/plugins/model-usage.tsx` in `tui.json`
  and place `model-usage-server.ts` + the `model-usage/` tree alongside it
  (the legacy layout). See `.agents/skills/deploy`.

The two layouts can coexist on disk; the runtime picks its own entrypoints.

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
after a v1→v2 migration leaves the old tables behind) all work: `/usage` reads
the **newest active dataset** first and only falls back to the other when it has
no rows in the requested window, so a hybrid DB is never double-counted. A
database with an unrecognised schema degrades to an empty view rather than a raw
`no such table` error. See `docs/opencode-v1-to-v2-migration.md`.

## Features

### Server (`model-usage/server.ts` — v2; `model-usage-server.ts` — deprecated v1)
On OpenCode 2.0.27 the server hooks `session.hook("context")`, which fires for the primary agent loop immediately before provider dispatch and carries **both** the assembled system parts (`event.system: SystemPart[]`) and the effective tool definitions (`event.tools`). This captures a pre-mutation server snapshot of the system prompt; the persona-injector sidecar can provide the final override. Title generation uses a separate hook, so it is structurally excluded (with a defensive title-generator guard retained). Both sequences re-measure on each qualifying call (keeps the latest — the system can grow mid-session as refs/MCP/skills load), though system snapshots may skip persistence when drift is ≤32 tokens; per-fragment char/4 breakdowns plus the raw text persist to `system-tokens.json` and `tool-defs.json` (FIFO-capped at 1000 entries). Used by `/analyze` for the System Breakdown and Tool Defs rows.

The deprecated v1 server (`model-usage-server.ts`) is unchanged and uses the v1 `experimental.chat.system.transform` + `tool.definition` hooks.

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
| `e` | Export to clipboard (Markdown / CSV / JSON / plain text) |
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
| `e` | Export to clipboard (Markdown / JSON / plain text — no CSV) |
| `h` | Toggle help |
| `esc` | Close |
| `1`-`5` on Extra Info | Expand hotspot messages |

Exports include the full raw system prompt and raw tool-definition text, preserved in full (not truncated). Background auto-poll every 60s keeps the dialog in sync.

## Requirements

- `GITHUB_TOKEN` (for Copilot quota display)
- opencode-go quota uses the first available credential, in priority order:
  - `OPENCODE_GO_API_KEY` — Console API key, sent as `Authorization: Bearer` to the usage API (preferred)
  - `~/.local/share/opencode/auth.json` — `opencode-go` entry with `type: "api"` (used when the env var is unset)
  - `OPENCODE_GO_AUTH_COOKIE` — legacy browser auth cookie; only used when no Bearer key is available, and additionally requires `OPENCODE_GO_WORKSPACE_ID` to scrape the workspace Go page. Accepts either a value-only auth cookie or a full `Cookie` header.

## Debug

Set `OPENCODE_COPILOT_DEBUG=true` to enable plugin debug logs (written to `model-usage/logs/`). Set `OPENCODE_WLIB_DEBUG=true` to enable logging from the shared `wlib` helpers.

## Structure

```
model-usage/                          # v2 plugin directory (deploy → ~/.config/opencode/plugins/model-usage/)
├── server.ts                         # v2 server entry (Plugin.define + session.hook("context"))
├── tui.tsx                           # v2 TUI entry (Plugin.define + createV2Host + slots/commands)
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

model-usage.tsx                       # DEPRECATED v1 TUI entry point
model-usage-server.ts                 # DEPRECATED v1 server entry point
tests/                                # Unit tests (tests/model-usage/*.test.ts)
```

See `docs/opencode-v1-to-v2-migration.md` for the full migration record and
`.agents/skills/plugin-development` for entrypoint/hook rules.

