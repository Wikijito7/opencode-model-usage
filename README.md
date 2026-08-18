# Model Usage

OpenCode plugin that tracks and visualises model usage, token consumption, and costs across sessions.

## Features

### Server (`model-usage-server.ts`)
Hooks `experimental.chat.system.transform` to capture a pre-mutation server snapshot of the system prompt on every main-chat call (skipping title-generator fires); the persona-injector sidecar can provide the final override. Also hooks `tool.definition` to capture each tool's definition fields, reconstructing the definition text from the captured `toolID`/`description`/`parameters` (no title-generator guard). Both re-measure on each qualifying call (keeps the latest — the system can grow mid-session as refs/MCP/skills load), though system snapshots may skip persistence when drift is ≤32 tokens; per-fragment char/4 breakdowns plus the raw text persist to `system-tokens.json` and `tool-defs.json` (FIFO-capped at 1000 entries). Used by `/analyze` for the System Breakdown and Tool Defs rows.

### Sidebar
Cost estimation (price-weighted input/output split from API) plus provider-specific quota:
- **GitHub Copilot** — premium request counting + monthly quota from GitHub API
- **opencode-go** — rolling (5h), weekly, and monthly quota scraped from opencode.ai

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
- `OPENCODE_GO_WORKSPACE_ID` (for opencode-go quota display) plus one auth option:
  - `OPENCODE_GO_AUTH_COOKIE` — browser auth cookie (preferred; required for fetching the web console page)
  - `~/.local/share/opencode/auth.json` — `opencode-go` entry with `type: "api"` (bearer fallback; checked before `OPENCODE_GO_API_KEY`)
  - `OPENCODE_GO_API_KEY` — last-resort bearer fallback (may not work for the web page)

## Debug

Set `OPENCODE_COPILOT_DEBUG=true` to enable plugin debug logs (written to `model-usage/logs/`). Set `OPENCODE_WLIB_DEBUG=true` to enable logging from the shared `wlib` helpers.

## Structure

```
model-usage/
├── model-usage.tsx                   # TUI entry point
├── model-usage-server.ts             # Server entry point (system prompt + tool def capture)
├── model-usage/
│   ├── analyze-domain.ts             # Per-session message analysis
│   ├── analyze.tsx                   # /analyze dialog
│   ├── cache.ts                      # Persistent month/week/day cache
│   ├── db.ts                         # SQLite query layer
│   ├── quota.ts                      # Copilot + opencode-go quota
│   ├── sidebar.tsx                   # Usage sidebar widget
│   ├── types.ts                      # Type definitions
│   ├── usage-domain.ts               # Usage data domain logic
│   ├── usage.tsx                     # /usage dialog
│   ├── version.ts                    # Plugin name + version
│   ├── helpers/                      # Utility modules
│   │   ├── compaction.ts             # Compaction delta estimation
│   │   ├── cost.ts                   # Cost formatting
│   │   ├── dates.ts                  # Date utilities
│   │   ├── debug.ts                  # Debug logging
│   │   ├── export/                   # Export serializers
│   │   │   ├── usage.ts              # /usage export (Markdown/CSV/JSON/text)
│   │   │   └── analyze.ts            # /analyze export (Markdown/JSON/text)
│   │   ├── format.ts                 # Token formatting
│   │   ├── fragments.ts             # System prompt fragment splitting
│   │   ├── hotspots.ts              # Unusually large message detection
│   │   ├── model-tab.ts             # Model comparison tab
│   │   ├── model.ts                  # Model definitions
│   │   ├── models.ts                # Per-model usage breakdown
│   │   ├── projection.ts            # Month-end cost projection
│   │   └── tokens.ts                # Token estimation (char/4)
│   ├── wlib/                         # Shared helper submodule (git submodule)
│   │   ├── clipboard.ts              # Raw text copy to clipboard
│   │   ├── command.ts                # Palette slash command registration
│   │   ├── copied-flash.tsx          # "Copied!" footer flash
│   │   ├── dialog-fit.ts             # Responsive dialog fit sizing (pure)
│   │   ├── dialog.tsx                # Responsive dialog sizing + dialog frame
│   │   ├── export.ts                 # Export contract (formats + Exportable)
│   │   ├── export-controller.tsx     # Reusable export controller + overlay key layer
│   │   ├── export-overlay.tsx        # Format picker overlay
│   │   ├── export-state.ts           # Export overlay state machine (pure)
│   │   ├── help.ts                   # Help overlay row builder
│   │   ├── help-overlay.tsx          # Help overlay dialog
│   │   ├── keys.ts                   # Dialog-scoped key layer registration
│   │   ├── log.ts                    # Unified debug logging
│   │   ├── reload.ts                 # Stale-fetch guard
│   │   ├── scroll.ts                 # Scroll state for scrollbox dialogs
│   │   ├── system.ts                 # System prompt snapshot contract
│   │   └── theme.ts                  # Normalized theme palette
└── tests/                            # Unit tests (tests/model-usage/*.test.ts)
```
