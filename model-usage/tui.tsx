/** @jsxImportSource @opentui/solid */
/**
 * model-usage — OpenCode v2 TUI entrypoint.
 *
 * Target: OpenCode `2.0.27` (`@opencode/plugin/tui`). This is the supported
 * production TUI plugin; the v1 entrypoint (`../model-usage.tsx`) is deprecated
 * and retained only for the transition window.
 *
 * Wiring:
 * - builds the wlib v2 host adapter **once** (`createV2Host`) and passes it to
 *   every helper, so commands/keymap/dialogs/theme/renderer share one adapter;
 * - claims the `sidebar.content` slot with the v2 sidebar;
 * - registers the `/usage` and `/analyze` commands through the host adapter.
 *
 * The v1 and v2 host APIs are never mixed: this module only imports the v2
 * adapter, and the v1 entrypoint only imports its own v1 modules.
 */

import { Plugin } from "@opencode/plugin/tui"
import { createV2Host } from "./wlib/src/host/v2"
import UsageSidebar from "./v2/sidebar"
import { registerUsageCommand } from "./v2/usage"
import { registerAnalyzeCommand } from "./v2/analyze"

export default Plugin.define({
  id: "model-usage",
  setup(context) {
    const host = createV2Host(context)

    context.ui.slot({
      append: "sidebar.content",
      render: (props) => <UsageSidebar context={context} host={host} session_id={props.sessionID} />,
    })

    registerUsageCommand(context, host)
    registerAnalyzeCommand(context, host)
  },
})
