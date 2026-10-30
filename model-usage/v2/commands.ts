/**
 * model-usage — v2 command identities.
 *
 * OpenCode v2 ships a **native** `/usage` command: id `usage.show`, slash
 * `usage`, opening the OpenCode Console limits dialog. The v2 keymap dedupes
 * commands **by id** and resolves the first (built-in) registration, so a plugin
 * that reuses that id silently loses its key binding, its palette entry and its
 * slash command — the plugin's binding dispatches by id and lands on the native
 * command instead.
 *
 * Every v2 command therefore lives under the `model-usage.*` namespace and uses
 * a slash name the host does not own. The v1 entrypoints keep `usage.show` /
 * `/usage` unchanged: v1 has no native usage command, so there is no collision.
 *
 * Pure module (no Solid/JSX) so tests can assert the identities directly.
 */

/** `/model-usage` — the historical monthly usage dialog. */
export const USAGE_COMMAND = {
  id: "model-usage.usage.show",
  title: "Show Monthly Usage",
  slash: "model-usage",
  key: "ctrl+shift+u",
  description: "Show Monthly Usage",
} as const
