/** @jsxImportSource @opentui/solid */
/**
 * OpenCode v1 TUI entrypoint (flat root file).
 *
 * Registered explicitly through v1 `tui.json`
 * (`{ "plugin": ["./plugins/model-usage.tsx"] }`). The supported v2 TUI
 * entrypoint is the `model-usage/` directory's `tui.tsx`; the shared v1/v2
 * server entry is the flat root `model-usage-server.ts` (default
 * `{ id, server, setup }`) — the plugin directory deliberately has no
 * package-root `server.ts`/`index.ts`, so v2 does not load a second server.
 * This file is a loose bare `.tsx` file, which v2's directory-only TUI discovery
 * never loads.
 *
 * It builds the deprecated wlib v1 host adapter once (`createV1Host`) and passes
 * it to the v1 dialogs alongside the raw `TuiPluginApi`. v1 and v2 host APIs are
 * never mixed in one adapter.
 */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createV1Host } from "./model-usage/wlib/src/host/v1"
import UsageSidebar from "./model-usage/sidebar"
import { registerUsageCommand } from "./model-usage/usage"
import { registerAnalyzeCommand } from "./model-usage/analyze"

const tui: TuiPlugin = async (api) => {
  const host = createV1Host(api)
  api.slots.register({
    order: 175,
    slots: {
      sidebar_content(_ctx, props) {
        return <UsageSidebar api={api} session_id={props.session_id} />
      },
    },
  })
  registerUsageCommand(api, host)
  registerAnalyzeCommand(api, host)
}

const plugin: TuiPluginModule & { id: string } = {
  id: "model-usage",
  tui,
}

export default plugin
