import { describe, it, expect, beforeAll } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"

// Regression coverage for the official same-root dual-generation entry and the
// plugin-directory layout that backs it:
//
//   repo root: model-usage-server.ts   -> default { id, server, setup }
//   package:   model-usage/            -> tui.tsx + server-setup.ts, and NO
//                                         server.ts / index.ts entrypoints
//
// The root entry is exercised at the import level (not by grepping its source):
// its only host reference is a type-only `@opencode/plugin` import inside the
// helper it re-exports, so it evaluates under `bun test` without a running host.

const repoRoot = join(import.meta.dir, "..", "..")
const packageDir = join(repoRoot, "model-usage")

type EntryModule = typeof import("../../model-usage-server")
type HelperModule = typeof import("@model-usage/server-setup")

let entry: EntryModule
let helper: HelperModule

beforeAll(async () => {
  entry = await import("../../model-usage-server")
  helper = await import("@model-usage/server-setup")
})

// ─── combined root entry default shape ────────────────────────────────────────

describe("root model-usage-server.ts default export", () => {
  it("exposes exactly the dual-generation object shape { id, server, setup }", () => {
    const plugin = entry.default
    expect(plugin).toBeDefined()
    expect(Object.keys(plugin).sort()).toEqual(["id", "server", "setup"])
  })

  it("carries the shared plugin id", () => {
    expect(entry.default.id).toBe("model-usage")
    expect(entry.default.id).toBe(helper.PLUGIN_ID)
  })

  it("exposes callable server (v1) and setup (v2) entry functions", () => {
    expect(typeof entry.default.server).toBe("function")
    expect(typeof entry.default.setup).toBe("function")
  })

  it("wires `server` to the existing named V1 plugin export", () => {
    expect(typeof entry.ModelUsageServerPlugin).toBe("function")
    expect(entry.default.server).toBe(entry.ModelUsageServerPlugin)
  })

  it("wires `setup` to the v2 helper's setup export", () => {
    expect(entry.default.setup).toBe(helper.setup)
  })
})

// ─── v2 helper is a non-entrypoint ────────────────────────────────────────────

describe("model-usage/server-setup.ts helper", () => {
  it("has the v2 setup implementation and shared id", () => {
    expect(typeof helper.setup).toBe("function")
    expect(helper.PLUGIN_ID).toBe("model-usage")
  })

  it("has NO default export so v2 directory resolution cannot load it as a server", () => {
    expect("default" in helper).toBe(false)
  })
})

// ─── plugin-directory layout ──────────────────────────────────────────────────

describe("model-usage package layout", () => {
  it("has no plugin-directory server.ts or index.ts", () => {
    expect(existsSync(join(packageDir, "server.ts"))).toBe(false)
    expect(existsSync(join(packageDir, "index.ts"))).toBe(false)
  })

  it("keeps the TUI entrypoint and the new v2 setup helper", () => {
    expect(existsSync(join(packageDir, "tui.tsx"))).toBe(true)
    expect(existsSync(join(packageDir, "server-setup.ts"))).toBe(true)
  })

  it("keeps the combined server as the flat root entry", () => {
    expect(existsSync(join(repoRoot, "model-usage-server.ts"))).toBe(true)
  })
})
