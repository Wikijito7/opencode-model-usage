import { describe, it, expect } from "bun:test"
import { USAGE_COMMAND } from "@model-usage/v2/commands"

/**
 * Regression guard for the native `/usage` collision: OpenCode v2 registers the
 * Console-limits dialog as id `usage.show` with slash `usage`, and the keymap
 * dedupes commands by id (first/built-in registration wins). Reusing either the
 * id or the slash makes the plugin's binding, palette entry and slash command
 * resolve to the native dialog. See `model-usage/v2/commands.ts`.
 */
describe("v2 command identities", () => {
  it("namespaces the usage command id so the native `usage.show` cannot shadow it", () => {
    expect(USAGE_COMMAND.id).toBe("model-usage.usage.show")
    expect(USAGE_COMMAND.id).not.toBe("usage.show")
    expect(USAGE_COMMAND.id.startsWith("model-usage.")).toBe(true)
  })

  it("uses a slash name the host does not own", () => {
    expect(USAGE_COMMAND.slash).toBe("model-usage")
    expect(USAGE_COMMAND.slash).not.toBe("usage")
  })

  it("keeps the existing shortcut and title", () => {
    expect(USAGE_COMMAND.key).toBe("ctrl+shift+u")
    expect(USAGE_COMMAND.title).toBe("Show Monthly Usage")
  })
})
