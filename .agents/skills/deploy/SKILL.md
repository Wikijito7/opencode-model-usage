---
name: deploy
description: "CRITICAL: Load when syncing repo changes to the live opencode plugins folder (~/.config/opencode/plugins/) so the user can test them. Missing this = stale deployed copy and test files shipped to production. Covers the cp/rsync mapping, exclusions, and runtime artifacts to preserve."
---

## When to use me
- After making changes to plugin code the user wants to test live
- When asked to "sync", "deploy", "copy to live", or "update the deployed copy"
- When new or removed files need to be reflected in the live folder

## Not intended for
- Writing plugin code → use `architecture` / `plugin-development`
- Running tests → use `testing` / `quality-check`

---

## Layout

**v2 (supported, OpenCode 2.0.27):** the safe layout is **one directory per
plugin under the plural `plugins/` root**, with a server entry and a TUI entry
inside it:

```
~/.config/opencode/plugins/
  model-usage/
    index.ts    # server entry (Plugin.define) — Host.resolve tries `server` first, then `index`
    tui.tsx     # TUI entry  (Plugin.define) — resolved as `tui`
```

Discovery facts that drive this layout:

- **Core/server discovery** scans the immediate children of **both `plugin/` and
  `plugins/`**, and admits bare `.ts`/`.js` files plus directories (and symlinks
  to either).
- **TUI discovery** scans immediate **directories / symlinks-to-dirs only**, and
  only under the **plural `plugins/`**.
- `Host.resolve` looks for the server entry as `server` **then falls back to
  `index`**, and for the TUI entry as `tui` (e.g. `tui.tsx`). So `index.ts` +
  `tui.tsx` is the safe, unambiguous pair; a `server.ts` server entry also
  resolves.
- Explicit local **file** config targets are **rejected** — a configured local
  plugin target must be a **directory**. Never register a loose entry file.

Deploy the `model-usage/` tree to `~/.config/opencode/plugins/model-usage/`; its
server entry + `tui.tsx` are picked up automatically. Do **not** copy the loose
v1 entry files into `plugins/` for a v2 install.

> ⚠️ **Test v2 in a separate config root from v1.** v1 ships flat entry files
> (e.g. a bare `model-usage-server.ts`) directly in `plugins/`. Under v2, core
> discovery **admits those bare `.ts` files** and tries to load them as v2 server
> plugins, which fails because v1 modules export no `default { id, setup }`.
> Keep the v1 and v2 config roots apart so v1's flat `.ts` files are never
> auto-discovered by `opencode2`. (Loose `.tsx` files such as `model-usage.tsx`
> are not admitted by core discovery, and TUI discovery ignores files entirely.)

**v1 (deprecated transition):** the legacy layout below (loose `model-usage.tsx` /
`model-usage-server.ts` + `model-usage/` dir registered via `tui.json`). This
layout lives in its **own** config root, not the v2 one.

| Source (repo) | v1 live destination | v2 live destination |
|---|---|---|
| `model-usage/` (dir, incl. server entry + `tui.tsx`) | `~/.config/opencode/plugins/model-usage/` | `~/.config/opencode/plugins/model-usage/` |
| `model-usage.tsx` | `~/.config/opencode/plugins/model-usage.tsx` | NOT copied |
| `model-usage-server.ts` | `~/.config/opencode/plugins/model-usage-server.ts` | NOT copied |
| `tests/`, `.agents/`, `README.md`, `docs/`, `tsconfig.json` | NOT synced | NOT synced |

## Rules (MUST)
- Only productive code ships. Tests (`*.test.ts`, `tests/`) MUST NOT be copied.
- v2 MUST NOT copy loose `*.ts` / `*.tsx` entry files into `plugins/` — only the
  plugin directory ships. Loose v1 `.ts` files there break v2 auto-discovery.
- Files removed in the repo are removed in live (`--delete`).
- Preserve runtime artifacts (never delete): `.usage-cache.json`, `system-tokens.json`, `tool-defs.json`, `logs/`.
- `wlib/` is inside `model-usage/`, so it's synced by the same command.
- Restart opencode after syncing (plugins load at startup).

## Sync command

Run from the repo root.

### v2 (supported) — directory plugin only

```bash
SRC="$(pwd)"
LIVE="$HOME/.config/opencode/plugins"   # v2 config root — keep separate from v1

# Mirror the plugin directory (adds new, updates changed, deletes removed), skip tests + artifacts.
# No `cp` of loose entry files: v2 discovery must only see the directory.
rsync -a --delete \
  --exclude '*.test.ts' \
  --exclude '.git' --exclude '.github/' --exclude '.gitignore' \
  --exclude 'tsconfig.json' --exclude 'README.md' --exclude 'LICENSE' \
  --exclude '*.bak' \
  --exclude '.usage-cache.json' --exclude 'system-tokens.json' --exclude 'tool-defs.json' \
  --exclude 'logs' \
  "$SRC/model-usage/" "$LIVE/model-usage/"

# Purge junk that leaked in from old `cp -r` deploys (safe to re-run, idempotent)
find "$LIVE/model-usage" -name '*.test.ts' -delete
rm -rf "$LIVE/model-usage/wlib/.git" "$LIVE/model-usage/wlib/.github"
rm -f  "$LIVE/model-usage/wlib/.gitignore" "$LIVE/model-usage/wlib/tsconfig.json" \
       "$LIVE/model-usage/wlib/README.md" "$LIVE/model-usage/wlib/LICENSE" \
       "$LIVE/model-usage/helpers/dates.ts.bak"
```

### v1 (deprecated transition) — loose entry files, separate config root

Only for the deprecated v1 install, in its own `LIVE` root. Never run this
against the v2 config root (see the warning above).

```bash
# 1) Loose entry files (registered via tui.json). v1 legacy only.
cp "$SRC/model-usage.tsx" "$SRC/model-usage-server.ts" "$LIVE/"
# 2) Then run the same directory mirror as the v2 block above to populate
#    "$LIVE/model-usage/" (loose entries + tree, in this v1-only config root).
```

## References
- `plugin-development` — entry points and hook wiring
- `wlib` — shared helpers shipped inside `model-usage/wlib/`
