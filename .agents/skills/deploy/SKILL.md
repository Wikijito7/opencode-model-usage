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

| Source (repo) | Live destination |
|---|---|
| `model-usage.tsx` | `~/.config/opencode/plugins/model-usage.tsx` |
| `model-usage-server.ts` | `~/.config/opencode/plugins/model-usage-server.ts` |
| `model-usage/` (dir) | `~/.config/opencode/plugins/model-usage/` |
| `tests/`, `.agents/`, `README.md`, `tsconfig.json` | NOT synced |

## Rules (MUST)
- Only productive code ships. Tests (`*.test.ts`, `tests/`) MUST NOT be copied.
- Files removed in the repo are removed in live (`--delete`).
- Preserve runtime artifacts (never delete): `.usage-cache.json`, `system-tokens.json`, `tool-defs.json`, `logs/`.
- `wlib/` is inside `model-usage/`, so it's synced by the same command.
- Restart opencode after syncing (plugins load at startup).

## Sync command

Run from the repo root:

```bash
SRC="$(pwd)"
LIVE="$HOME/.config/opencode/plugins"

# 1) Entry points — cp
cp "$SRC/model-usage.tsx" "$SRC/model-usage-server.ts" "$LIVE/"

# 2) Source tree — mirror (adds new files, updates changed, deletes removed), skip tests + artifacts
rsync -a --delete \
  --exclude '*.test.ts' \
  --exclude '.git' --exclude '.github/' --exclude '.gitignore' \
  --exclude 'tsconfig.json' --exclude 'README.md' --exclude 'LICENSE' \
  --exclude '*.bak' \
  --exclude '.usage-cache.json' --exclude 'system-tokens.json' --exclude 'tool-defs.json' \
  --exclude 'logs' \
  "$SRC/model-usage/" "$LIVE/model-usage/"

# 3) rm — purge junk that leaked in from old `cp -r` deploys (safe to re-run, idempotent)
find "$LIVE/model-usage" -name '*.test.ts' -delete
rm -rf "$LIVE/model-usage/wlib/.git" "$LIVE/model-usage/wlib/.github"
rm -f  "$LIVE/model-usage/wlib/.gitignore" "$LIVE/model-usage/wlib/tsconfig.json" \
       "$LIVE/model-usage/wlib/README.md" "$LIVE/model-usage/wlib/LICENSE" \
       "$LIVE/model-usage/helpers/dates.ts.bak"
```

## References
- `plugin-development` — entry points and hook wiring
- `wlib` — shared helpers shipped inside `model-usage/wlib/`
