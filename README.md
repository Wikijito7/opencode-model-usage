# Model Usage

OpenCode plugin that tracks and visualises model usage, token consumption, and costs across sessions.

## Features

### Server (`model-usage-server.ts`)
Hooks `experimental.chat.system.transform` to capture the fully-assembled system prompt on every main-chat call. Skips title-generator fires, re-measures on each qualifying call (keeps the latest — the system can grow mid-session as refs/MCP/skills load), and persists a per-fragment char/4 breakdown to `system-tokens.json`. Used by `/analyze` for the System Breakdown rows.

### Sidebar
Cost estimation (price-weighted input/output split from API) plus provider-specific quota:
- **GitHub Copilot** — premium request counting + monthly quota from GitHub API
- **opencode-go** — rolling (5h), weekly, and monthly quota scraped from opencode.ai

### `/usage` command (`Ctrl+Shift+U`)
Monthly token breakdown per model (top 10) with progress bars, queried from OpenCode's SQLite database.

| Key | Action |
|---|---|
| `←` / `→` (or `h` / `l`) | Navigate months |
| `t` | Jump back to current month |
| `m` | Toggle mode (month ↔ week ↔ day) |
| `r` | Reload current data |
| `↑` / `↓` (or `j` / `k`) | Scroll |
| `PgUp` / `PgDn` | Page scroll |

### `/analyze` command (`Ctrl+Shift+A`)
Per-session context token breakdown for the open session. Categorises every message part into SYSTEM / USER / ASSISTANT / TOOLS / REASONING.

**Tabbed layout** — `←` `→` (or `h` `l`) to switch tabs:
- **Context** — all categories with percentage bars and session total
- **Per-Tool** — tool-level token breakdown (output + call arguments) grouped by tool name
- **System** — per-fragment system token breakdown (agent prompt, instructions, environment, skills, MCP, refs, jungle persona…). Fragments are split from the assembled prompt via `Instructions from:` markers, XML section tags, and plugin injection boundaries. Tab only appears when ≥2 fragments exist
- **Models** — per-model breakdown (input/output/cache/tokens/cost) with message counts. Only when >1 model used
- **Extra Info** — Top Contributors, Session cost, Compaction events, Model switches, Hotspot messages (expandable via digit keys 1-5 or mouse click)

**System token tiers:**
1. **Baseline DB** — exact assembled system text from V2 native runner
2. **Telemetry** — reconstituted from API telemetry when baseline unavailable
3. **Server plugin** — char/4 from `system-tokens.json` fallback
4. No data — SYSTEM omitted

**Additional controls:**

| Key | Action |
|---|---|
| `v` on System tab | Toggle raw system prompt visor (up to 50k chars) |
| `c` on System tab | Copy raw text to clipboard |
| `r` | Reload / recalculate |
| `↑` / `↓` (or `j` / `k`) | Scroll |
| `1`-`5` on Extra Info | Expand hotspot messages |

Background auto-poll every 60s keeps the dialog in sync.

## Requirements

- `GITHUB_TOKEN` (for Copilot quota display)
- `OPENCODE_GO_WORKSPACE_ID` + `OPENCODE_GO_AUTH_COOKIE` (for opencode-go quota display)

## Debug

Set `OPENCODE_COPILOT_DEBUG=true` to enable debug logs (written to `logs/`).

## Structure

```
model-usage/
├── model-usage.tsx                   # TUI entry point
├── model-usage-server.ts             # Server entry point (system prompt capture)
├── model-usage/
│   ├── analyze-domain.ts             # Per-session message analysis
│   ├── analyze.tsx                   # /analyze dialog
│   ├── cache.ts                      # Persistent month cache
│   ├── db.ts                         # SQLite query layer
│   ├── quota.ts                      # Copilot + opencode-go quota
│   ├── sidebar.tsx                   # Usage sidebar widget
│   ├── types.ts                      # Type definitions
│   ├── usage-domain.ts               # Usage data domain logic
│   ├── usage.test.ts                 # Usage unit tests
│   ├── usage.tsx                     # /usage dialog
│   ├── helpers/                      # Utility modules
│   │   ├── clipboard.ts              # Raw text copy to clipboard
│   │   ├── compaction.ts             # Compaction delta estimation
│   │   ├── cost.ts                   # Cost formatting
│   │   ├── dates.ts                  # Date utilities
│   │   ├── debug.ts                  # Debug logging
│   │   ├── format.ts                 # Token formatting
│   │   ├── fragments.ts             # System prompt fragment splitting
│   │   ├── hotspots.ts              # Unusually large message detection
│   │   ├── model-tab.ts             # Model comparison tab
│   │   ├── model.ts                  # Model definitions
│   │   ├── models.ts                # Per-model usage breakdown
│   │   └── tokens.ts                # Token estimation (char/4)
│   └── shared/                       # Shared UI utilities
│       ├── keys.ts                   # Dialog key layer registration
│       ├── reload.ts                 # Stale-load guard
│       └── scroll.ts                 # Scroll state management
└── tests/                            # Unit tests
```
