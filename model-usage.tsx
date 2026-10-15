/** @jsxImportSource @opentui/solid */
/**
 * DEPRECATED — OpenCode v1 TUI entrypoint.
 *
 * Retained for the transition window only. The supported production entrypoint
 * is the v2 plugin directory (`./model-usage/tui.tsx` + `./model-usage/server.ts`,
 * resolved by OpenCode 2.0.27's plugin discovery). This file is a loose plugin
 * source registered through v1 `tui.json`; OpenCode v2 discovery only loads a
 * plugin **directory's** `tui`/`server` entrypoints, so this file is never
 * auto-loaded by v2.
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
