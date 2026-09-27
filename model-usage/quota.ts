import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import type { CopilotQuotaInfo, GoQuotaBar, GoQuotaInfo } from "./types"
import { log } from "./helpers/debug"

/** Canonical JSON usage endpoint (Bearer console API key, no workspace/cookie). */
const GO_USAGE_API_URL = "https://opencode.ai/zen/go/v1/usage"

/** Legacy workspace Go console page (HTML scrape, cookie auth). */
const GO_LEGACY_WORKSPACE_URL = "https://opencode.ai/workspace"

/** Matches the inline usage objects embedded in the legacy Go console HTML. */
const LEGACY_QUOTA_PATTERNS: Record<keyof GoQuotaInfo, RegExp> = {
  rolling: /rollingUsage:\$R\[\d+\]=(\{[^}]+\})/,
  weekly: /weeklyUsage:\$R\[\d+\]=(\{[^}]+\})/,
  monthly: /monthlyUsage:\$R\[\d+\]=(\{[^}]+\})/,
}

/**
 * Creates a simple re-entrancy guard. Returns a wrapper that ensures only one
 * call to `fn` is in-flight at a time. Subsequent calls while a previous one is
 * pending are silently dropped.
 */
export function withGuard<T>(fn: () => Promise<T>): () => Promise<T | undefined> {
  let inFlight = false
  return async () => {
    if (inFlight) return undefined
    inFlight = true
    try {
      return await fn()
    } finally {
      inFlight = false
    }
  }
}

export type GoAuth = { type: "bearer" | "cookie"; value: string }

/**
 * Resolve Go credentials, in priority order:
 *  1. `OPENCODE_GO_API_KEY` (Console API key)
 *  2. `~/.local/share/opencode/auth.json` `opencode-go` entry with `type: "api"`
 *  3. `OPENCODE_GO_AUTH_COOKIE` (legacy browser cookie for the HTML console page)
 *
 * Credential values are never logged here.
 */
export function getGoAuth(): GoAuth | null {
  // 1. Explicit API key env var (preferred — works against the JSON usage API).
  // Trim first so a whitespace-only value is rejected rather than sent as a key.
  const apiKey = process.env.OPENCODE_GO_API_KEY?.trim()
  if (apiKey) return { type: "bearer", value: apiKey }

  // 2. opencode auth.json (opencode-go api entry)
  try {
    const authPath = `${homedir()}/.local/share/opencode/auth.json`
    if (existsSync(authPath)) {
      const raw = readFileSync(authPath, "utf8")
      const auth = JSON.parse(raw)
      const entry = auth?.["opencode-go"]
      // Require both credential fields to be non-empty strings before use as a
      // Bearer value. Trim so a whitespace-only key is rejected; meaningful key
      // contents are otherwise preserved verbatim.
      if (entry?.type === "api" && typeof entry?.key === "string") {
        const key = entry.key.trim()
        if (key.length > 0) return { type: "bearer", value: key }
      }
    }
  } catch {
    // ignore unreadable/malformed auth file
  }

  // 3. Legacy browser auth cookie (HTML scrape fallback only). Trim so a
  // whitespace-only cookie is rejected rather than used as auth.
  const cookie = process.env.OPENCODE_GO_AUTH_COOKIE?.trim()
  if (cookie) return { type: "cookie", value: cookie }

  return null
}

/** Coerce a usage percent; returns null for missing/non-finite/out-of-range values. */
function parsePercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) return null
  return value
}

/**
 * Convert an ISO reset timestamp into seconds-from-now, clamped to >= 0.
 * Returns null when `resetsAt` is missing or not a parseable date — callers
 * treat that as a malformed window (fail closed) since the API contract
 * requires a reset timestamp.
 */
function resetInSecFromIso(resetsAt: unknown): number | null {
  if (typeof resetsAt !== "string") return null
  const ts = Date.parse(resetsAt)
  if (!Number.isFinite(ts)) return null
  return Math.max(0, Math.round((ts - Date.now()) / 1000))
}

/** Window statuses the API contract considers valid. */
const VALID_WINDOW_STATUSES = new Set(["ok", "rate-limited"])

/**
 * Accepts a window's `status`. Absent status is tolerated for legacy-like
 * payloads; a present status must be one of the known-valid values so that a
 * malformed/unknown status is never treated as a usable window.
 */
function isAcceptableStatus(status: unknown): boolean {
  if (status === undefined) return true
  return typeof status === "string" && VALID_WINDOW_STATUSES.has(status)
}

/**
 * Parse a single `{ status, percent, resetsAt }` usage window into the
 * dashboard's `GoQuotaBar`. Returns null when the window is missing, its
 * status is malformed, its percent is out of range, or its reset timestamp is
 * missing/invalid.
 */
function parseUsageWindow(raw: unknown): GoQuotaBar | null {
  if (!raw || typeof raw !== "object") return null
  const window = raw as { status?: unknown; percent?: unknown; resetsAt?: unknown }
  if (!isAcceptableStatus(window.status)) return null
  const usagePercent = parsePercent(window.percent)
  if (usagePercent === null) return null
  const resetInSec = resetInSecFromIso(window.resetsAt)
  if (resetInSec === null) return null
  return { usagePercent, resetInSec }
}

/** Fetch quota via the canonical JSON API using a Bearer console API key. */
async function fetchGoQuotaViaApi(apiKey: string): Promise<GoQuotaInfo | null> {
  try {
    const response = await fetch(GO_USAGE_API_URL, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "User-Agent": "opencode-model-usage-plugin",
      },
    })

    if (!response.ok) {
      log("fetchGoQuota: usage API not ok, status:", response.status)
      return null
    }

    const data = await response.json().catch(() => null)
    const usage = (data as { usage?: unknown } | null)?.usage
    if (!usage || typeof usage !== "object") {
      log("fetchGoQuota: usage API response missing usage object")
      return null
    }

    const record = usage as Record<string, unknown>
    const info: GoQuotaInfo = {
      rolling: parseUsageWindow(record.rolling),
      weekly: parseUsageWindow(record.weekly),
      monthly: parseUsageWindow(record.monthly),
    }

    if (!info.rolling && !info.weekly && !info.monthly) {
      log("fetchGoQuota: usage API returned no usable windows")
      return null
    }

    return info
  } catch (err) {
    log("fetchGoQuota: usage API error:", String(err))
    return null
  }
}

/**
 * Cookie names commonly used for auth/session that should be treated as an
 * already-formed `name=value` Cookie header rather than an opaque value.
 * Compared case-insensitively.
 */
const COMMON_AUTH_COOKIE_NAMES = new Set([
  "auth",
  "session",
  "sessionid",
  "session_id",
  "sid",
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "jwt",
  "csrf",
  "csrf_token",
  "xsrf-token",
  "__session",
  "__host-session",
  "__secure-session",
  "next-auth.session-token",
])

/** Matches a leading cookie `name=` pair (RFC 6265 cookie-name token chars). */
const COOKIE_NAME_PAIR = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+)=/

/** True when the value already looks like a Cookie header rather than a raw value. */
function looksLikeCookieHeader(value: string): boolean {
  // Multiple pairs are unambiguously a full Cookie header.
  if (value.includes(";")) return true
  // A single `name=value` pair counts only for known auth/session names, so that
  // base64 value-only cookies (e.g. `dGVzdA==`) are not mistaken for a pair.
  const match = value.match(COOKIE_NAME_PAIR)
  return match !== null && COMMON_AUTH_COOKIE_NAMES.has(match[1].toLowerCase())
}

/**
 * Normalize a cookie value into a Cookie header. Accepts either a full header
 * (e.g. `auth=...; other=...` or a single `session=...` pair) or a value-only
 * auth cookie (including base64 values with `=` padding).
 */
function buildCookieHeader(cookieValue: string): string {
  const trimmed = cookieValue.trim()
  if (looksLikeCookieHeader(trimmed)) {
    return trimmed
  }
  return `auth=${trimmed}`
}

/** Heuristic for a login/redirect landing page returned instead of real quota HTML. */
function looksLikeLoginPage(html: string): boolean {
  return (
    /<title>[^<]*(sign\s*in|log\s*in|login)/i.test(html) ||
    /Continue with (Google|GitHub)/i.test(html) ||
    /name=["']?signin/i.test(html)
  )
}

/** Legacy fallback: scrape the workspace Go console page with a browser cookie. */
async function fetchGoQuotaViaCookie(cookieValue: string): Promise<GoQuotaInfo | null> {
  const workspaceId = process.env.OPENCODE_GO_WORKSPACE_ID
  if (!workspaceId) {
    log("fetchGoQuota: legacy cookie auth requires OPENCODE_GO_WORKSPACE_ID")
    return null
  }

  try {
    const response = await fetch(`${GO_LEGACY_WORKSPACE_URL}/${encodeURIComponent(workspaceId)}/go`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        Accept: "text/html,application/xhtml+xml",
        Cookie: buildCookieHeader(cookieValue),
      },
      // Do not follow redirects — a redirect means we were bounced to login.
      redirect: "manual",
    })

    if (response.status >= 300 && response.status < 400) {
      log("fetchGoQuota: legacy page redirected (likely login), status:", response.status)
      return null
    }
    if (!response.ok) {
      log("fetchGoQuota: legacy page not ok, status:", response.status)
      return null
    }

    const html = await response.text()
    if (looksLikeLoginPage(html)) {
      log("fetchGoQuota: legacy page looks like a login page")
      return null
    }

    const info: GoQuotaInfo = { rolling: null, weekly: null, monthly: null }
    for (const [key, pattern] of Object.entries(LEGACY_QUOTA_PATTERNS) as Array<[keyof GoQuotaInfo, RegExp]>) {
      const match = html.match(pattern)
      if (!match) continue
      try {
        const jsonStr = match[1].replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g, '$1"$2"$3')
        const parsed = JSON.parse(jsonStr) as { status?: unknown; usagePercent?: unknown; resetInSec?: unknown }
        if (!isAcceptableStatus(parsed?.status)) continue
        const usagePercent = parsePercent(parsed?.usagePercent)
        if (usagePercent === null) continue
        // Fail closed on a malformed reset: a missing, non-numeric, or
        // non-finite `resetInSec` discards the window rather than defaulting to
        // 0, matching the canonical API path. A valid 0 is preserved.
        const rawResetInSec = parsed?.resetInSec
        if (typeof rawResetInSec !== "number" || !Number.isFinite(rawResetInSec)) continue
        info[key] = { usagePercent, resetInSec: Math.max(0, Math.round(rawResetInSec)) }
      } catch {
        // ignore individual parse failures
      }
    }

    if (!info.rolling && !info.weekly && !info.monthly) {
      log("fetchGoQuota: legacy page contained no parseable quota")
      return null
    }

    return info
  } catch (err) {
    log("fetchGoQuota: legacy fetch error:", String(err))
    return null
  }
}

export async function fetchGoQuota(): Promise<GoQuotaInfo | null> {
  const auth = getGoAuth()
  if (!auth) {
    log("fetchGoQuota: no Go credentials configured")
    return null
  }

  if (auth.type === "bearer") {
    return fetchGoQuotaViaApi(auth.value)
  }

  // Cookie auth is only used when no Bearer key is available.
  return fetchGoQuotaViaCookie(auth.value)
}

export async function fetchQuotaInfo(token: string): Promise<CopilotQuotaInfo | null> {
  try {
    log("fetchQuotaInfo: fetching quota from github API")
    const response = await fetch("https://api.github.com/copilot_internal/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "X-GitHub-Api-Version": "2026-06-01",
        "User-Agent": "opencode-copilot-usage-plugin",
      },
    })

    log("fetchQuotaInfo: response status:", response.status)
    if (!response.ok) {
      log("fetchQuotaInfo: response not ok, body:", await response.text().catch(() => "failed to read"))
      return null
    }

    const data = await response.json()
    log("fetchQuotaInfo: copilot_plan:", data?.copilot_plan)

    // Paid plan: try premium_models first, fall back to premium_interactions.
    // AI Credits detection: check snapshot.token_based_billing or root token_based_billing flag
    // (GitHub migrated from count-based "premium requests" to token-based "AI Credits").
    const snapshot = data?.quota_snapshots?.premium_models ?? data?.quota_snapshots?.premium_interactions
    if (snapshot) {
      return {
        percentRemaining: snapshot.percent_remaining ?? 100,
        entitlement: snapshot.entitlement ?? 0,
        remaining: snapshot.remaining ?? 0,
        overageCount: snapshot.overage_count ?? 0,
        overagePermitted: snapshot.overage_permitted ?? false,
        unlimited: snapshot.unlimited ?? false,
        planType: "paid",
        quotaType: (data?.quota_snapshots?.premium_models || snapshot.token_based_billing || data?.token_based_billing) ? "ai_credits" : "premium",
      }
    }

    // Free plan: limited_user_quotas + monthly_quotas
    const chatRemaining = data?.limited_user_quotas?.chat
    const chatMonthly = data?.monthly_quotas?.chat
    if (chatRemaining != null && chatMonthly != null && chatMonthly > 0) {
      const percentRemaining = Math.round((chatRemaining / chatMonthly) * 1000) / 10
      log("fetchQuotaInfo: free plan, chat remaining:", chatRemaining, "/", chatMonthly, "=", percentRemaining.toFixed(1) + "%")
      return {
        percentRemaining,
        entitlement: chatMonthly,
        remaining: chatRemaining,
        overageCount: 0,
        overagePermitted: false,
        unlimited: false,
        planType: "free",
        quotaType: "premium",
      }
    }

    log("fetchQuotaInfo: no quota data found")
    return null
  } catch (err) {
    log("fetchQuotaInfo: error:", String(err))
    return null
  }
}
