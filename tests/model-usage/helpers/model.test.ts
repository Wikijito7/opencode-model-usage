import { describe, expect, it } from "bun:test"
import {
  isCopilotModel,
  isOpencodeGoModel,
  resolveActiveModel,
  buildUsageHeaderLabel,
  prettifyProvider,
} from "@model-usage/helpers/model"

// ─── isCopilotModel ────────────────────────────────────────────────────────────

describe("isCopilotModel", () => {
  it("returns true for github-copilot model names", () => {
    expect(isCopilotModel("github-copilot/gpt-4o")).toBe(true)
  })

  it("returns true for a capitalized Copilot name", () => {
    expect(isCopilotModel("Copilot X")).toBe(true)
  })

  it("returns true when copilot appears embedded in the name", () => {
    expect(isCopilotModel("my-copilot-helper/model")).toBe(true)
  })

  it("returns false for a plain model name", () => {
    expect(isCopilotModel("gpt-4o")).toBe(false)
  })

  it("returns false for an opencode-go model", () => {
    expect(isCopilotModel("opencode-go/x")).toBe(false)
  })

  it("returns false for an empty string", () => {
    expect(isCopilotModel("")).toBe(false)
  })

  it("is case-insensitive", () => {
    expect(isCopilotModel("GITHUB-COPLOT/gpt")).toBe(false) // typo stays false
    expect(isCopilotModel("GitHub-Copilot/GPT-4o")).toBe(true)
    expect(isCopilotModel("COPILOT")).toBe(true)
    expect(isCopilotModel("copilot")).toBe(true)
  })
})

// ─── isOpencodeGoModel ─────────────────────────────────────────────────────────

describe("isOpencodeGoModel", () => {
  it("returns true for opencode-go model names", () => {
    expect(isOpencodeGoModel("opencode-go/claude-x")).toBe(true)
  })

  it("returns true for a case-variant opencode-go name", () => {
    expect(isOpencodeGoModel("OpenCode-Go/y")).toBe(true)
  })

  it("returns true when opencode-go appears embedded", () => {
    expect(isOpencodeGoModel("router/opencode-go/claude-x")).toBe(true)
  })

  it("returns false for a bare go model name", () => {
    expect(isOpencodeGoModel("go/x")).toBe(false)
  })

  it("returns false for a github-copilot model", () => {
    expect(isOpencodeGoModel("github-copilot/gpt")).toBe(false)
  })

  it("returns false for an empty string", () => {
    expect(isOpencodeGoModel("")).toBe(false)
  })

  it("is case-insensitive", () => {
    expect(isOpencodeGoModel("OPEncode-GO/claude-x")).toBe(true)
    expect(isOpencodeGoModel("opencode-go")).toBe(true)
    expect(isOpencodeGoModel("OPENCODE-GO")).toBe(true)
  })
})

// ─── resolveActiveModel ────────────────────────────────────────────────────────

describe("resolveActiveModel", () => {
  it("config path wins over messages even when messages have assistant entries", () => {
    const messages = [
      { role: "assistant", providerID: "other-provider", modelID: "other-model" },
    ]
    expect(resolveActiveModel("anthropic/claude-sonnet-4", messages)).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4",
    })
  })

  it("parses provider from the substring before the first '/'", () => {
    expect(resolveActiveModel("provider/model", [])).toEqual({
      providerID: "provider",
      modelID: "model",
    })
  })

  it("parses multi-slash config using only the first '/'", () => {
    expect(resolveActiveModel("a/b/c", [])).toEqual({
      providerID: "a",
      modelID: "b/c",
    })
  })

  it("returns providerID null and full string as modelID when config has no '/'", () => {
    expect(resolveActiveModel("plain-model", [])).toEqual({
      providerID: null,
      modelID: "plain-model",
    })
  })

  it("null configModel falls through to message scanning", () => {
    const messages = [
      { role: "assistant", providerID: "p", modelID: "m" },
    ]
    expect(resolveActiveModel(null, messages)).toEqual({
      providerID: "p",
      modelID: "m",
    })
  })

  it("undefined configModel falls through to message scanning", () => {
    const messages = [
      { role: "assistant", providerID: "p", modelID: "m" },
    ]
    expect(resolveActiveModel(undefined, messages)).toEqual({
      providerID: "p",
      modelID: "m",
    })
  })

  it("empty-string configModel falls through to message scanning", () => {
    const messages = [
      { role: "assistant", providerID: "p", modelID: "m" },
    ]
    expect(resolveActiveModel("", messages)).toEqual({
      providerID: "p",
      modelID: "m",
    })
  })

  it("message path picks the LAST matching assistant message", () => {
    const messages = [
      { role: "assistant", providerID: "earlier", modelID: "earlier-model" },
      { role: "assistant", providerID: "later", modelID: "later-model" },
    ]
    expect(resolveActiveModel(undefined, messages)).toEqual({
      providerID: "later",
      modelID: "later-model",
    })
  })

  it("message path wins when a later candidate follows an earlier one", () => {
    const messages = [
      { role: "user", providerID: "u", modelID: "user-model" },
      { role: "assistant", providerID: "first", modelID: "first-model" },
      { role: "assistant", providerID: "second", modelID: "second-model" },
    ]
    expect(resolveActiveModel(undefined, messages)).toEqual({
      providerID: "second",
      modelID: "second-model",
    })
  })

  it("ignores user-role messages", () => {
    const messages = [
      { role: "user", providerID: "u", modelID: "user-model" },
    ]
    expect(resolveActiveModel(undefined, messages)).toBeNull()
  })

  it("ignores assistant messages without modelID", () => {
    const messages = [
      { role: "assistant", providerID: "p" },
      { role: "assistant", modelID: "" },
      { role: "assistant" },
    ]
    expect(resolveActiveModel(undefined, messages)).toBeNull()
  })

  it("ignores assistant messages with empty modelID", () => {
    const messages = [
      { role: "assistant", providerID: "p", modelID: "" },
    ]
    expect(resolveActiveModel(undefined, messages)).toBeNull()
  })

  it("captures providerID from the winning message", () => {
    const messages = [
      { role: "assistant", providerID: "captured", modelID: "m" },
    ]
    expect(resolveActiveModel(undefined, messages)).toEqual({
      providerID: "captured",
      modelID: "m",
    })
  })

  it("maps empty-string providerID to null", () => {
    const messages = [
      { role: "assistant", providerID: "", modelID: "m" },
    ]
    expect(resolveActiveModel(undefined, messages)).toEqual({
      providerID: null,
      modelID: "m",
    })
  })

  it("maps missing providerID to null", () => {
    const messages = [
      { role: "assistant", modelID: "m" },
    ]
    expect(resolveActiveModel(undefined, messages)).toEqual({
      providerID: null,
      modelID: "m",
    })
  })

  it("returns null when no config and no qualifying messages", () => {
    expect(resolveActiveModel(undefined, [])).toBeNull()
    expect(resolveActiveModel(null, [])).toBeNull()
    expect(resolveActiveModel("", [])).toBeNull()
  })

  it("picks the last qualifying assistant message even when later ones are ignored", () => {
    const messages = [
      { role: "assistant", providerID: "winner", modelID: "win" },
      { role: "user", providerID: "u", modelID: "um" },
      { role: "assistant" }, // no modelID, ignored
    ]
    expect(resolveActiveModel(undefined, messages)).toEqual({
      providerID: "winner",
      modelID: "win",
    })
  })
})

// ─── prettifyProvider ──────────────────────────────────────────────────────────

describe("prettifyProvider", () => {
  it("title-cases a dashed provider id", () => {
    expect(prettifyProvider("github-copilot")).toBe("Github Copilot")
  })

  it("title-cases a multi-word provider id", () => {
    expect(prettifyProvider("mlx-lm")).toBe("Mlx Lm")
  })

  it("returns a single word as-is with the first letter capitalized", () => {
    expect(prettifyProvider("anthropic")).toBe("Anthropic")
  })

  it("normalizes multiple and adjacent dashes", () => {
    expect(prettifyProvider("a--b---c")).toBe("A B C")
  })

  it("drops leading and trailing dashes", () => {
    expect(prettifyProvider("-leading-")).toBe("Leading")
  })

  it("returns an empty string for an empty provider id", () => {
    expect(prettifyProvider("")).toBe("")
  })

  it("returns an empty string for an undefined provider id", () => {
    expect(prettifyProvider(undefined)).toBe("")
  })

  it("returns an empty string for a null provider id", () => {
    expect(prettifyProvider(null)).toBe("")
  })
})

// ─── buildUsageHeaderLabel ─────────────────────────────────────────────────────

describe("buildUsageHeaderLabel", () => {
  it("brands an opencode-go model as OpenCode Go Usage", () => {
    expect(buildUsageHeaderLabel("any", "opencode-go/claude-x")).toBe("OpenCode Go Usage")
  })

  it("brands a copilot model as GitHub Copilot Usage", () => {
    expect(buildUsageHeaderLabel("any", "github-copilot/gpt-4o")).toBe("GitHub Copilot Usage")
  })

  it("gives the opencode-go model check precedence even when providerID is set", () => {
    expect(buildUsageHeaderLabel("lmstudio", "opencode-go/x")).toBe("OpenCode Go Usage")
  })

  it("gives the copilot model check precedence over a providerID", () => {
    expect(buildUsageHeaderLabel("lmstudio", "github-copilot/gpt")).toBe("GitHub Copilot Usage")
  })

  it("uses a truthy providerID for a generic model", () => {
    expect(buildUsageHeaderLabel("lmstudio", "qwen2.5-coder")).toBe("Lmstudio Usage")
  })

  it("prettifies a dashed provider id into a display name", () => {
    expect(buildUsageHeaderLabel("github-copilot", "gpt-4o")).toBe("GitHub Copilot Usage")
    expect(prettifyProvider("github-copilot")).toBe("Github Copilot")
    expect(prettifyProvider("mlx-lm")).toBe("Mlx Lm")
  })

  it("Title-Cases the providerID in the label", () => {
    expect(buildUsageHeaderLabel("anthropic", "claude-sonnet-4")).toBe("Anthropic Usage")
  })

  it("brands an opencode-go providerID as OpenCode Go Usage", () => {
    expect(buildUsageHeaderLabel("opencode-go", "x")).toBe("OpenCode Go Usage")
  })

  it("falls back to 'Usage' for an all-dashes providerID", () => {
    expect(buildUsageHeaderLabel("---", "some-model")).toBe("Usage")
  })

  it("falls back to 'Usage' for null providerID", () => {
    expect(buildUsageHeaderLabel(null, "claude-sonnet-4")).toBe("Usage")
  })

  it("falls back to 'Usage' for undefined providerID", () => {
    expect(buildUsageHeaderLabel(undefined, "claude-sonnet-4")).toBe("Usage")
  })

  it("falls back to 'Usage' for empty-string providerID", () => {
    expect(buildUsageHeaderLabel("", "claude-sonnet-4")).toBe("Usage")
  })
})
