export interface ActiveModelInfo {
  providerID: string | null
  modelID: string
}

export function isCopilotModel(modelName: string): boolean {
  if (!modelName) return false
  return modelName.toLowerCase().includes("copilot")
}

export function isOpencodeGoModel(modelName: string): boolean {
  if (!modelName) return false
  return modelName.toLowerCase().includes("opencode-go")
}

// Resolve the active model for sidebar display.
// Priority: global config model (format "provider/model") wins over the last assistant message.
export function resolveActiveModel(
  configModel: string | undefined | null,
  messages: readonly { role: string; providerID?: string; modelID?: string }[]
): ActiveModelInfo | null {
  if (configModel && configModel.trim().length > 0) {
    const idx = configModel.indexOf("/")
    if (idx > 0) {
      return { providerID: configModel.slice(0, idx), modelID: configModel.slice(idx + 1) }
    }
    return { providerID: null, modelID: configModel }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === "assistant" && msg.modelID) {
      const providerID = msg.providerID && msg.providerID.length > 0 ? msg.providerID : null
      return { providerID, modelID: msg.modelID }
    }
  }
  return null
}

// Normalize a raw provider id into a display name: "github-copilot" -> "Github Copilot".
export function prettifyProvider(providerID: string | null | undefined): string {
  if (!providerID) return ""
  return providerID
    .replace(/-+/g, " ")
    .split(" ")
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
}

export function buildUsageHeaderLabel(providerID: string | null | undefined, modelID: string): string {
  if (isOpencodeGoModel(modelID) || isOpencodeGoModel(providerID ?? "")) return "OpenCode Go Usage"
  if (isCopilotModel(modelID) || isCopilotModel(providerID ?? "")) return "GitHub Copilot Usage"
  const pretty = prettifyProvider(providerID)
  if (pretty) return `${pretty} Usage`
  return "Usage"
}
