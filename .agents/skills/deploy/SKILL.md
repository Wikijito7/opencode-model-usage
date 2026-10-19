---
name: deploy
description: "CRITICAL: Load when syncing repo changes to the live opencode plugins folders so the user can test them. Missing this = stale deployed copy and test files shipped to production. Covers the shared normal config root (~/.config/opencode/plugins) that BOTH v1 and v2 discover, the combined v1/v2 server entry, the v2 TUI directory entry, the v1 `tui.json` / v2 `cli.json` config mapping, the optional isolated sandbox for data separation, the cp/rsync mapping, and exclusions."
---

## When to use me
- After making changes to plugin code the user wants to test live
- When asked to "sync", "deploy", "copy to live", or "update the deployed copy"
- When new or changed files need to be reflected in the live folder (removed
  files are pruned manually — the sync is additive)
- When switching a user between the v1 and v2 host generations

## Not intended for
- Writing plugin code → use `architecture` / `plugin-development`
- Running tests → use `testing` / `quality-check`

---

## Root model (read this first)

Both generations deploy to the **same normal config root** and are discovered
from it automatically — **no separate HOME is required**:

- `LIVE="$HOME/.config/opencode/plugins"` — the one normal root both `opencode`
  (v1) and `opencode2` (v2) read.

How each generation picks its entries from that shared root:

- **Server (both):** the flat `model-usage-server.ts` default-exports
  `{ id, server, setup }`. v1 reads `server`; v2 core discovery admits bare `.ts`
  children and reads `id` + `setup`, ignoring the extra `server`. One file serves
  both generations.
- **v1 TUI:** the flat `model-usage.tsx`, explicitly registered in `tui.json`
  (`{ "plugin": ["./plugins/model-usage.tsx"] }`).
- **v2 TUI:** the `model-usage/` **directory**, resolved as its `tui` entry
  (`tui.tsx`). The directory deliberately has **no package-root `server.ts` /
  `index.ts`**; v2 core discovery skips a directory with no server entry, so it
  never loads a second server.
- **Config (both, hand-edited):** v1 keeps its loose `.tsx` TUI entry registered
  in `tui.json`; v2 lists the plugin **directories** in `cli.json`
  (`{ "plugins": ["./plugins/model-usage", "./plugins/persona-injector"] }`).
  These config files live in `~/.config/opencode/` (not in `plugins/`) and the
  sync never targets them.
- v2 TUI discovery admits only directories (never bare files), so the flat
  `model-usage.tsx` is not loaded by v2; v1 loads its TUI entry explicitly from
  `tui.json` and its server entries from flat files, so the `tui.tsx` / `v2/`
  modules inside `model-usage/` do not affect it.

**Optional isolated sandbox (data separation only).** If the user wants v2's
*user state* (SQLite DB, auth, caches, exports) kept apart from v1, deploy the
same file set into an **isolated root** and launch v2 with `HOME`/XDG redirected
there (see “Sandbox”). That requires a **separate code copy** of the plugin tree
under the isolated root's `plugins/` directory — the shared root is not reused.
This is **not required for discovery** and must never be treated as mandatory.
The combined server entry is designed so the shared root loads exactly one
server per generation.

## Layout

Ship this exact set into `LIVE`:

```
$LIVE/                                # $HOME/.config/opencode/plugins
  model-usage-server.ts               # shared v1/v2 server entry { id, server, setup }
  model-usage.tsx                     # v1 TUI entry (registered via tui.json)
  model-usage/
    tui.tsx                           # v2 TUI entry (the directory's only entry)
    server-setup.ts                   # v2 setup helper imported by model-usage-server.ts
    v2/ helpers/ wlib/ …              # shared modules (incl. v2-only dialogs)
```

- The `model-usage/` directory must contain **no** `server.ts` / `index.ts`.
- The flat `model-usage.tsx` and `model-usage-server.ts` must be present. The
  root server file imports `./model-usage/server-setup`, so `server-setup.ts`
  **must** ship inside the directory (it is v1-loadable: its only
  `@opencode/plugin` reference is a type-only import).

## Rules (MUST)
- Only productive code ships. Tests (`*.test.ts`, `tests/`) MUST NOT be copied.
- **Never add a package-root `server.ts` / `index.ts` to `model-usage/`** — the
  directory would resolve a server entry again and v2 would load a second,
  conflicting server. The v2 server is the shared root `model-usage-server.ts`.
- Keep the flat `model-usage-server.ts` at the root; removing it removes the
  server for both generations.
- **Sync is additive (no `--delete`).** Removed or renamed repo files are NOT
  auto-pruned from live, and unknown runtime files in the live tree are never
  destroyed — prune stale files manually when the repo drops one. (The only
  automatic removal is the explicit purge of a stale package-root server entry
  in the sync command.)
- **Never sync Markdown** (or any docs): `*.md` and `docs/` are excluded, so the
  repository's documentation is never copied into a live plugins tree.
- Preserve runtime artifacts (never delete): `.usage-cache.json`,
  `system-tokens.json`, `tool-defs.json`, `logs/`. Because the sync is additive,
  any runtime-generated file written into a live `model-usage/` dir is left
  untouched even when it is not in the excludes.
- Preserve hand-edited config (`tui.json`, `opencode.json(c)`, `cli.json`) and
  any foreign plugin files in the shared root (`persona-injector*`,
  `notifications*`, `usage-command.tsx`, …); the sync only targets the flat
  `model-usage.tsx` / `model-usage-server.ts` and the `model-usage/` directory,
  so it never touches them.
- `wlib/` is inside `model-usage/`, so it's synced by the same command.
- Restart opencode after syncing (plugins load at startup).

## Sync command

Run from the repo root.

```bash
SRC="$(pwd)"
LIVE="$HOME/.config/opencode/plugins"   # the one normal root both generations use

# 1) Flat entry files: the shared root server entry + the v1 TUI entry.
cp "$SRC/model-usage.tsx" "$SRC/model-usage-server.ts" "$LIVE/"

# 2) Additive mirror of the shared plugin directory: adds/updates only, never
#    deletes (so unknown runtime files and foreign content survive). Tests,
#    Markdown, VCS metadata and known runtime artifacts are excluded.
rsync -a \
  --exclude '*.test.ts' \
  --exclude '.git' --exclude '.github/' --exclude '.gitignore' \
  --exclude 'tsconfig.json' --exclude '*.md' --exclude 'docs/' --exclude 'LICENSE' \
  --exclude '*.bak' \
  --exclude '.usage-cache.json' --exclude 'system-tokens.json' --exclude 'tool-defs.json' \
  --exclude 'logs' \
  "$SRC/model-usage/" "$LIVE/model-usage/"

# 3) Purge a stale package-root server entry from older layouts (idempotent).
#    A package-root server would make v2 load a second server; never keep one.
rm -f "$LIVE/model-usage/server.ts" "$LIVE/model-usage/index.ts"
```

## Sandbox (optional — data separation only)

To keep v2's user state apart from v1, deploy the **same** file set into an
isolated root and launch the v2 binary with `HOME`/XDG redirected there:

```bash
# Same-root default is unchanged: with OPENCODE_V2_HOME unset, ordinary
# `opencode2` stays on the shared normal root and needs no sandbox at all.
# Capture the normal HOME *before* redirecting and resolve symlinks, so the
# guard compares real directories (e.g. /var vs /private/var).
ORIG_HOME="$HOME"
resolve_physical() { ( cd "$1" 2>/dev/null && pwd -P ) || return 1; }
REAL_HOME="$(resolve_physical "$ORIG_HOME")"
V2_HOME_IN="${OPENCODE_V2_HOME:-$HOME/.opencode-v2}"

# Guard: reject empty, "/", an unresolved ".." over a missing path, and any
# value that is the normal HOME raw or after symlink resolution. The sandbox
# destination variables below are assigned ONLY after this guard passes.
if [ -z "$V2_HOME_IN" ] || [ "$V2_HOME_IN" = "/" ]; then
  echo "Refusing to launch v2: OPENCODE_V2_HOME must be a non-empty path other than '/'." >&2
  echo "Leave it unset to run the ordinary same-root opencode2." >&2
  exit 1
fi
REAL_V2_HOME=""
if [ -e "$V2_HOME_IN" ]; then
  REAL_V2_HOME="$(resolve_physical "$V2_HOME_IN")" || {
    echo "Refusing to launch v2: OPENCODE_V2_HOME does not resolve ($V2_HOME_IN)." >&2
    exit 1
  }
else
  case "/$V2_HOME_IN/" in
    *"/../"*)
      echo "Refusing to launch v2: OPENCODE_V2_HOME has an unresolved '..' over a missing path ($V2_HOME_IN)." >&2
      exit 1
      ;;
  esac
fi
if [ "$V2_HOME_IN" = "$ORIG_HOME" ] ||
   { [ -n "$REAL_V2_HOME" ] && [ "$REAL_V2_HOME" = "$REAL_HOME" ]; }; then
  echo "Refusing to launch v2: OPENCODE_V2_HOME resolves to the normal HOME ($ORIG_HOME)." >&2
  echo "Set OPENCODE_V2_HOME to an isolated root, e.g. \$HOME/.opencode-v2." >&2
  exit 1
fi

# Guard passed — now, and only now, assign the sandbox destinations.
export V2_HOME="$V2_HOME_IN"
V2_LIVE="$V2_HOME/.config/opencode/plugins"
mkdir -p "$V2_LIVE"
# The sandbox needs its OWN code copy: re-run the sync command above with
# LIVE="$V2_LIVE" (it does not share or symlink the normal root). The sandbox
# also needs its own cli.json/tui.json under "$V2_HOME/.config/opencode/".

export HOME="$V2_HOME"
export OPENCODE_CONFIG_DIR="$V2_HOME/.config/opencode"
export XDG_CONFIG_HOME="$V2_HOME/.config"
export XDG_DATA_HOME="$V2_HOME/.local/share"
export XDG_CACHE_HOME="$V2_HOME/.cache"
export XDG_STATE_HOME="$V2_HOME/.local/state"
opencode2
```

This is path/config isolation, not an OS security boundary — it changes which
default paths resolve, but plugins, absolute paths, symlinks, and shared mounts
can still reach the v1 tree. The deploy copies no credentials or DB, so a fresh
sandbox authenticates itself separately.

## References
- `plugin-development` — entry points and hook wiring
- `wlib` — shared helpers shipped inside `model-usage/wlib/`
- `docs/opencode-v1-to-v2-migration.md` — the v1 → v2 migration record
