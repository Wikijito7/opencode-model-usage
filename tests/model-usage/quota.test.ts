import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test"
import * as fs from "node:fs"
import { withGuard, getGoAuth, fetchGoQuota, fetchQuotaInfo } from "@model-usage/quota"

// ─── Isolation ────────────────────────────────────────────────────────────────
// The real `~/.local/share/opencode/auth.json` must never leak into the suite:
// `existsSync` defaults to false and `readFileSync` to throwing. Individual tests
// opt in via `stubAuthJson`. `globalThis.fetch` is always stubbed so no test can
// hit the network. `process.env` and `Date.now` are snapshotted and restored.

const ENV_KEYS = [
  "OPENCODE_GO_API_KEY",
  "OPENCODE_GO_AUTH_COOKIE",
  "OPENCODE_GO_WORKSPACE_ID",
] as const

// Fixed "now" so ISO→seconds conversion is deterministic.
const NOW = Date.UTC(2026, 0, 1, 0, 0, 0)

let savedEnv: Record<string, string | undefined>
let fetchSpy: ReturnType<typeof spyOn>
let existsSpy: ReturnType<typeof spyOn>
let readSpy: ReturnType<typeof spyOn>
let nowSpy: ReturnType<typeof spyOn>

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key]
}

function restoreEnv() {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

/** Make the (mocked) auth file appear present with the given JSON content. */
function stubAuthJson(value: unknown) {
  existsSpy.mockImplementation(() => true)
  readSpy.mockImplementation(() => JSON.stringify(value))
}

/** Minimal Response double for the JSON usage API. */
function jsonResponse(
  data: unknown,
  init: { ok?: boolean; status?: number } = {},
): any {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  }
}

/** Minimal Response double for the legacy HTML page. */
function htmlResponse(
  html: string,
  init: { ok?: boolean; status?: number } = {},
): any {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    text: async () => html,
    json: async () => {
      throw new Error("not json")
    },
  }
}

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
  }
  clearEnv()

  nowSpy = spyOn(Date, "now").mockImplementation(() => NOW)
  existsSpy = spyOn(fs, "existsSync").mockImplementation(() => false)
  readSpy = spyOn(fs, "readFileSync").mockImplementation(() => {
    throw new Error("ENOENT")
  })
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("fetch was not stubbed")
  })
})

afterEach(() => {
  fetchSpy.mockRestore()
  existsSpy.mockRestore()
  readSpy.mockRestore()
  nowSpy.mockRestore()
  restoreEnv()
})

// ─── withGuard ────────────────────────────────────────────────────────────────

describe("withGuard", () => {
  it("runs a single call and returns its resolved value", async () => {
    let calls = 0
    const wrapped = withGuard(async () => {
      calls++
      return "value"
    })

    await expect(wrapped()).resolves.toBe("value")
    expect(calls).toBe(1)
  })

  it("suppresses concurrent calls while one is in-flight", async () => {
    let resolveFirst: (value: string) => void = () => {}
    let calls = 0
    const wrapped = withGuard(async () => {
      calls++
      return new Promise<string>((resolve) => {
        resolveFirst = resolve
      })
    })

    const first = wrapped()
    const second = await wrapped()
    const third = await wrapped()

    expect(second).toBeUndefined()
    expect(third).toBeUndefined()
    expect(calls).toBe(1)

    resolveFirst("done")
    await expect(first).resolves.toBe("done")
  })

  it("allows a new call after the previous one resolves", async () => {
    let calls = 0
    const wrapped = withGuard(async () => {
      calls++
      return calls
    })

    await expect(wrapped()).resolves.toBe(1)
    await expect(wrapped()).resolves.toBe(2)
    expect(calls).toBe(2)
  })

  it("recovers and re-runs after a rejection", async () => {
    let attempt = 0
    const wrapped = withGuard(async () => {
      attempt++
      if (attempt === 1) throw new Error("boom")
      return "recovered"
    })

    await expect(wrapped()).rejects.toThrow("boom")
    await expect(wrapped()).resolves.toBe("recovered")
    expect(attempt).toBe(2)
  })
})

// ─── getGoAuth precedence ─────────────────────────────────────────────────────

describe("getGoAuth precedence", () => {
  it("returns null when no credentials are configured", () => {
    expect(getGoAuth()).toBeNull()
  })

  it("prefers OPENCODE_GO_API_KEY over auth.json and cookie", () => {
    process.env.OPENCODE_GO_API_KEY = "env-key"
    process.env.OPENCODE_GO_AUTH_COOKIE = "cookie-value"
    stubAuthJson({ "opencode-go": { type: "api", key: "file-key" } })

    expect(getGoAuth()).toEqual({ type: "bearer", value: "env-key" })
    // Env key short-circuits before the auth file is ever touched.
    expect(existsSpy).not.toHaveBeenCalled()
    expect(readSpy).not.toHaveBeenCalled()
  })

  it("uses the auth.json opencode-go api entry when the env key is absent", () => {
    process.env.OPENCODE_GO_AUTH_COOKIE = "cookie-value"
    stubAuthJson({ "opencode-go": { type: "api", key: "file-key" } })

    expect(getGoAuth()).toEqual({ type: "bearer", value: "file-key" })
  })

  it("ignores an auth.json entry whose type is not api and falls back to cookie", () => {
    process.env.OPENCODE_GO_AUTH_COOKIE = "cookie-value"
    stubAuthJson({ "opencode-go": { type: "oauth", key: "file-key" } })

    expect(getGoAuth()).toEqual({ type: "cookie", value: "cookie-value" })
  })

  it("ignores an auth.json entry with no key and falls back to cookie", () => {
    process.env.OPENCODE_GO_AUTH_COOKIE = "cookie-value"
    stubAuthJson({ "opencode-go": { type: "api" } })

    expect(getGoAuth()).toEqual({ type: "cookie", value: "cookie-value" })
  })

  it("ignores an auth.json entry whose key is empty or not a string", () => {
    process.env.OPENCODE_GO_AUTH_COOKIE = "cookie-value"

    stubAuthJson({ "opencode-go": { type: "api", key: "" } })
    expect(getGoAuth()).toEqual({ type: "cookie", value: "cookie-value" })

    stubAuthJson({ "opencode-go": { type: "api", key: 123 } })
    expect(getGoAuth()).toEqual({ type: "cookie", value: "cookie-value" })
  })

  it("ignores a whitespace-only OPENCODE_GO_API_KEY and falls through to the cookie", () => {
    process.env.OPENCODE_GO_API_KEY = "   \t\n"
    process.env.OPENCODE_GO_AUTH_COOKIE = "cookie-value"

    expect(getGoAuth()).toEqual({ type: "cookie", value: "cookie-value" })
    // A blank env key must not short-circuit; the auth file is still consulted.
    expect(existsSpy).toHaveBeenCalled()
  })

  it("ignores a whitespace-only OPENCODE_GO_API_KEY and falls through to auth.json", () => {
    process.env.OPENCODE_GO_API_KEY = "   "
    stubAuthJson({ "opencode-go": { type: "api", key: "file-key" } })

    expect(getGoAuth()).toEqual({ type: "bearer", value: "file-key" })
  })

  it("returns null for a whitespace-only OPENCODE_GO_API_KEY when nothing else is configured", () => {
    process.env.OPENCODE_GO_API_KEY = "   "

    expect(getGoAuth()).toBeNull()
  })

  it("trims surrounding whitespace from a non-empty OPENCODE_GO_API_KEY", () => {
    process.env.OPENCODE_GO_API_KEY = "  env-key  "

    expect(getGoAuth()).toEqual({ type: "bearer", value: "env-key" })
  })

  it("ignores a whitespace-only auth.json key and falls back to the cookie", () => {
    process.env.OPENCODE_GO_AUTH_COOKIE = "cookie-value"
    stubAuthJson({ "opencode-go": { type: "api", key: "   " } })

    expect(getGoAuth()).toEqual({ type: "cookie", value: "cookie-value" })
  })

  it("ignores a whitespace-only auth.json key and returns null without a cookie", () => {
    stubAuthJson({ "opencode-go": { type: "api", key: "  \t " } })

    expect(getGoAuth()).toBeNull()
  })

  it("trims surrounding whitespace from a non-empty auth.json key", () => {
    stubAuthJson({ "opencode-go": { type: "api", key: "  file-key  " } })

    expect(getGoAuth()).toEqual({ type: "bearer", value: "file-key" })
  })

  it("ignores a whitespace-only OPENCODE_GO_AUTH_COOKIE", () => {
    process.env.OPENCODE_GO_AUTH_COOKIE = "   \t\n"

    expect(getGoAuth()).toBeNull()
  })

  it("falls through a blank env key and blank auth key to a valid cookie", () => {
    process.env.OPENCODE_GO_API_KEY = "   "
    process.env.OPENCODE_GO_AUTH_COOKIE = "cookie-value"
    stubAuthJson({ "opencode-go": { type: "api", key: "  " } })

    expect(getGoAuth()).toEqual({ type: "cookie", value: "cookie-value" })
  })

  it("survives a malformed auth.json and falls back to cookie", () => {
    process.env.OPENCODE_GO_AUTH_COOKIE = "cookie-value"
    existsSpy.mockImplementation(() => true)
    readSpy.mockImplementation(() => "{ not valid json")

    expect(getGoAuth()).toEqual({ type: "cookie", value: "cookie-value" })
  })

  it("falls back to OPENCODE_GO_AUTH_COOKIE when auth.json has no opencode-go entry", () => {
    process.env.OPENCODE_GO_AUTH_COOKIE = "cookie-value"
    stubAuthJson({ github: { type: "oauth", key: "gh" } })

    expect(getGoAuth()).toEqual({ type: "cookie", value: "cookie-value" })
  })
})

// ─── Canonical Bearer JSON API ────────────────────────────────────────────────

describe("fetchGoQuota (canonical bearer API)", () => {
  it("requests the exact endpoint with Authorization/Accept and ignores the workspace", async () => {
    process.env.OPENCODE_GO_API_KEY = "test-key"
    // Deliberately unset to prove the canonical API needs no workspace id.
    expect(process.env.OPENCODE_GO_WORKSPACE_ID).toBeUndefined()

    fetchSpy.mockImplementation(async () =>
      jsonResponse({ usage: { rolling: { percent: 10, resetsAt: null } } }),
    )

    await fetchGoQuota()

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, any]
    expect(url).toBe("https://opencode.ai/zen/go/v1/usage")
    expect(url).not.toContain("workspace")
    expect(init.headers.Authorization).toBe("Bearer test-key")
    expect(init.headers.Accept).toBe("application/json")
    expect(init.headers.Cookie).toBeUndefined()
    expect(init.redirect).toBeUndefined()
  })

  it("parses rolling/weekly/monthly percent and reset timestamps", async () => {
    process.env.OPENCODE_GO_API_KEY = "test-key"

    fetchSpy.mockImplementation(async () =>
      jsonResponse({
        usage: {
          rolling: { status: "ok", percent: 12.5, resetsAt: new Date(NOW + 3_600_000).toISOString() },
          weekly: { status: "ok", percent: 0, resetsAt: new Date(NOW - 1_000).toISOString() },
          monthly: { status: "ok", percent: 42.5, resetsAt: new Date(NOW + 7_200_000).toISOString() },
        },
      }),
    )

    const info = await fetchGoQuota()

    expect(info).toEqual({
      rolling: { usagePercent: 12.5, resetInSec: 3600 },
      weekly: { usagePercent: 0, resetInSec: 0 },
      monthly: { usagePercent: 42.5, resetInSec: 7200 },
    })
  })

  it("rounds reset seconds and clamps elapsed timestamps to zero", async () => {
    process.env.OPENCODE_GO_API_KEY = "test-key"

    fetchSpy.mockImplementation(async () =>
      jsonResponse({
        usage: {
          rolling: { percent: 1, resetsAt: new Date(NOW + 1_500).toISOString() },
          weekly: { percent: 1, resetsAt: new Date(NOW - 90_000).toISOString() },
        },
      }),
    )

    const info = await fetchGoQuota()

    expect(info?.rolling?.resetInSec).toBe(2)
    expect(info?.weekly?.resetInSec).toBe(0)
  })

  it("treats a valid zero-percent window as quota data, not null", async () => {
    process.env.OPENCODE_GO_API_KEY = "test-key"

    fetchSpy.mockImplementation(async () =>
      jsonResponse({
        usage: { rolling: { status: "ok", percent: 0, resetsAt: new Date(NOW + 60_000).toISOString() } },
      }),
    )

    const info = await fetchGoQuota()

    expect(info).not.toBeNull()
    expect(info?.rolling).toEqual({ usagePercent: 0, resetInSec: 60 })
    expect(info?.weekly).toBeNull()
    expect(info?.monthly).toBeNull()
  })

  it("rejects percent above 100 and drops only that window", async () => {
    process.env.OPENCODE_GO_API_KEY = "test-key"
    const iso = new Date(NOW + 60_000).toISOString()

    fetchSpy.mockImplementation(async () =>
      jsonResponse({
        usage: {
          rolling: { status: "ok", percent: 150, resetsAt: iso },
          weekly: { status: "ok", percent: 100, resetsAt: iso },
          monthly: { status: "ok", percent: 0, resetsAt: iso },
        },
      }),
    )

    const info = await fetchGoQuota()

    // 150 is out of range → dropped; the inclusive 0–100 boundaries are kept.
    expect(info).toEqual({
      rolling: null,
      weekly: { usagePercent: 100, resetInSec: 60 },
      monthly: { usagePercent: 0, resetInSec: 60 },
    })
  })

  it("returns null when every window has percent above 100", async () => {
    process.env.OPENCODE_GO_API_KEY = "test-key"
    const iso = new Date(NOW + 60_000).toISOString()

    fetchSpy.mockImplementation(async () =>
      jsonResponse({
        usage: {
          rolling: { status: "ok", percent: 150, resetsAt: iso },
          weekly: { status: "ok", percent: 101, resetsAt: iso },
          monthly: { status: "ok", percent: 100.5, resetsAt: iso },
        },
      }),
    )

    expect(await fetchGoQuota()).toBeNull()
  })

  it("drops windows whose resetsAt is missing, non-string, or unparseable", async () => {
    process.env.OPENCODE_GO_API_KEY = "test-key"
    const iso = new Date(NOW + 60_000).toISOString()

    fetchSpy.mockImplementation(async () =>
      jsonResponse({
        usage: {
          rolling: { status: "ok", percent: 1, resetsAt: undefined },
          weekly: { status: "ok", percent: 2, resetsAt: 12345 },
          monthly: { status: "ok", percent: 3, resetsAt: "not-a-date" },
        },
      }),
    )

    expect(await fetchGoQuota()).toBeNull()
  })

  it("keeps a valid window while dropping a sibling with a malformed resetsAt", async () => {
    process.env.OPENCODE_GO_API_KEY = "test-key"
    const iso = new Date(NOW + 60_000).toISOString()

    fetchSpy.mockImplementation(async () =>
      jsonResponse({
        usage: {
          rolling: { status: "ok", percent: 4, resetsAt: iso },
          weekly: { status: "ok", percent: 5, resetsAt: { nested: true } },
          monthly: { status: "ok", percent: 6 },
        },
      }),
    )

    const info = await fetchGoQuota()

    expect(info).toEqual({
      rolling: { usagePercent: 4, resetInSec: 60 },
      weekly: null,
      monthly: null,
    })
  })

  it("drops windows with an unknown or non-string status, keeping valid statuses", async () => {
    process.env.OPENCODE_GO_API_KEY = "test-key"
    const iso = new Date(NOW + 60_000).toISOString()

    fetchSpy.mockImplementation(async () =>
      jsonResponse({
        usage: {
          rolling: { status: "bogus", percent: 11, resetsAt: iso },
          weekly: { status: 42, percent: 22, resetsAt: iso },
          monthly: { status: "rate-limited", percent: 33, resetsAt: iso },
        },
      }),
    )

    const info = await fetchGoQuota()

    // Unknown/non-string statuses are malformed → dropped; "rate-limited" is valid.
    expect(info).toEqual({
      rolling: null,
      weekly: null,
      monthly: { usagePercent: 33, resetInSec: 60 },
    })
  })

  it("tolerates an absent status but rejects an explicit null status", async () => {
    process.env.OPENCODE_GO_API_KEY = "test-key"
    const iso = new Date(NOW + 60_000).toISOString()

    fetchSpy.mockImplementation(async () =>
      jsonResponse({
        usage: {
          rolling: { percent: 11, resetsAt: iso },
          weekly: { status: null, percent: 22, resetsAt: iso },
        },
      }),
    )

    const info = await fetchGoQuota()

    expect(info).toEqual({
      rolling: { usagePercent: 11, resetInSec: 60 },
      weekly: null,
      monthly: null,
    })
  })

  it("drops a window whose percent is missing even when its status is ok and resetsAt is valid", async () => {
    process.env.OPENCODE_GO_API_KEY = "test-key"
    const iso = new Date(NOW + 60_000).toISOString()

    fetchSpy.mockImplementation(async () =>
      jsonResponse({
        usage: {
          rolling: { status: "ok", resetsAt: iso },
          weekly: { status: "ok", percent: 5, resetsAt: iso },
        },
      }),
    )

    const info = await fetchGoQuota()

    expect(info?.rolling).toBeNull()
    expect(info?.weekly).toEqual({ usagePercent: 5, resetInSec: 60 })
  })

  it("represents partial quota so missing windows (null) stay distinct from zero windows", async () => {
    process.env.OPENCODE_GO_API_KEY = "test-key"
    const isoZero = new Date(NOW + 60_000).toISOString()
    const isoMonthly = new Date(NOW + 120_000).toISOString()

    fetchSpy.mockImplementation(async () =>
      jsonResponse({
        usage: {
          rolling: { status: "ok", percent: 0, resetsAt: isoZero },
          monthly: { status: "ok", percent: 7, resetsAt: isoMonthly },
          // weekly intentionally absent
        },
      }),
    )

    const info = await fetchGoQuota()

    // A legitimate 0% window is a non-null bar; an absent window is null.
    // This is the shape the sidebar relies on to tell them apart.
    expect(info).toEqual({
      rolling: { usagePercent: 0, resetInSec: 60 },
      weekly: null,
      monthly: { usagePercent: 7, resetInSec: 120 },
    })
    expect(info?.rolling).not.toBeNull()
    expect(info?.weekly).toBeNull()
  })

  it("returns null on a non-OK response", async () => {
    process.env.OPENCODE_GO_API_KEY = "test-key"

    fetchSpy.mockImplementation(async () =>
      jsonResponse({ usage: { rolling: { percent: 50 } } }, { ok: false, status: 500 }),
    )

    expect(await fetchGoQuota()).toBeNull()
  })

  it("returns null when the usage object is missing", async () => {
    process.env.OPENCODE_GO_API_KEY = "test-key"

    fetchSpy.mockImplementation(async () => jsonResponse({}))
    expect(await fetchGoQuota()).toBeNull()

    fetchSpy.mockImplementation(async () => jsonResponse({ usage: "nope" }))
    expect(await fetchGoQuota()).toBeNull()
  })

  it("returns null when all windows are malformed", async () => {
    process.env.OPENCODE_GO_API_KEY = "test-key"

    fetchSpy.mockImplementation(async () =>
      jsonResponse({
        usage: {
          rolling: { percent: "50" },
          weekly: { percent: -1 },
          monthly: { percent: Number.NaN },
        },
      }),
    )

    expect(await fetchGoQuota()).toBeNull()
  })

  it("returns null when the response body is not valid JSON", async () => {
    process.env.OPENCODE_GO_API_KEY = "test-key"

    fetchSpy.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("invalid json")
      },
      text: async () => "not json",
    }))

    expect(await fetchGoQuota()).toBeNull()
  })

  it("returns null when the network request rejects", async () => {
    process.env.OPENCODE_GO_API_KEY = "test-key"

    fetchSpy.mockImplementation(async () => {
      throw new Error("network down")
    })

    expect(await fetchGoQuota()).toBeNull()
  })
})

// ─── Legacy cookie fallback ───────────────────────────────────────────────────

describe("fetchGoQuota (legacy cookie fallback)", () => {
  const LEGACY_HTML = `
    <script>
      rollingUsage:$R[0]={status:"ok",usagePercent:25,resetInSec:60};
      weeklyUsage:$R[1]={status:"ok",usagePercent:0,resetInSec:120};
      monthlyUsage:$R[2]={status:"ok",usagePercent:80,resetInSec:300};
    </script>`

  function useCookieAuth(cookie = "cookie-value") {
    process.env.OPENCODE_GO_AUTH_COOKIE = cookie
  }

  it("returns null and does not fetch without OPENCODE_GO_WORKSPACE_ID", async () => {
    useCookieAuth()

    expect(await fetchGoQuota()).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("wraps a value-only cookie as auth=... and parses the page", async () => {
    useCookieAuth("abc123")
    process.env.OPENCODE_GO_WORKSPACE_ID = "ws-1"
    fetchSpy.mockImplementation(async () => htmlResponse(LEGACY_HTML))

    const info = await fetchGoQuota()

    expect(info).toEqual({
      rolling: { usagePercent: 25, resetInSec: 60 },
      weekly: { usagePercent: 0, resetInSec: 120 },
      monthly: { usagePercent: 80, resetInSec: 300 },
    })

    const [url, init] = fetchSpy.mock.calls[0] as [string, any]
    expect(url).toBe("https://opencode.ai/workspace/ws-1/go")
    expect(init.headers.Cookie).toBe("auth=abc123")
    expect(init.redirect).toBe("manual")
  })

  it("preserves a full Cookie header", async () => {
    useCookieAuth("auth=xyz; theme=dark")
    process.env.OPENCODE_GO_WORKSPACE_ID = "ws-1"
    fetchSpy.mockImplementation(async () => htmlResponse(LEGACY_HTML))

    await fetchGoQuota()

    const [, init] = fetchSpy.mock.calls[0] as [string, any]
    expect(init.headers.Cookie).toBe("auth=xyz; theme=dark")
  })

  it("preserves a value-only cookie containing base64 '=' padding", async () => {
    useCookieAuth("dGVzdA==")
    process.env.OPENCODE_GO_WORKSPACE_ID = "ws-1"
    fetchSpy.mockImplementation(async () => htmlResponse(LEGACY_HTML))

    await fetchGoQuota()

    const [, init] = fetchSpy.mock.calls[0] as [string, any]
    expect(init.headers.Cookie).toBe("auth=dGVzdA==")
  })

  it("preserves a single-pair auth= cookie header", async () => {
    useCookieAuth("auth=xyz")
    process.env.OPENCODE_GO_WORKSPACE_ID = "ws-1"
    fetchSpy.mockImplementation(async () => htmlResponse(LEGACY_HTML))

    await fetchGoQuota()

    const [, init] = fetchSpy.mock.calls[0] as [string, any]
    expect(init.headers.Cookie).toBe("auth=xyz")
  })

  it("preserves a multi-pair header whose first pair is session= (not auth=)", async () => {
    useCookieAuth("session=abc; other=1")
    process.env.OPENCODE_GO_WORKSPACE_ID = "ws-1"
    fetchSpy.mockImplementation(async () => htmlResponse(LEGACY_HTML))

    await fetchGoQuota()

    const [, init] = fetchSpy.mock.calls[0] as [string, any]
    expect(init.headers.Cookie).toBe("session=abc; other=1")
  })

  it("preserves a single-pair session= cookie header", async () => {
    useCookieAuth("session=abc")
    process.env.OPENCODE_GO_WORKSPACE_ID = "ws-1"
    fetchSpy.mockImplementation(async () => htmlResponse(LEGACY_HTML))

    await fetchGoQuota()

    const [, init] = fetchSpy.mock.calls[0] as [string, any]
    expect(init.headers.Cookie).toBe("session=abc")
  })

  it("recognizes common auth cookie names case-insensitively as a header", async () => {
    useCookieAuth("SessionID=abc123")
    process.env.OPENCODE_GO_WORKSPACE_ID = "ws-1"
    fetchSpy.mockImplementation(async () => htmlResponse(LEGACY_HTML))

    await fetchGoQuota()

    const [, init] = fetchSpy.mock.calls[0] as [string, any]
    expect(init.headers.Cookie).toBe("SessionID=abc123")
  })

  it("wraps an unrecognized single-pair cookie as auth=...", async () => {
    useCookieAuth("foo=bar")
    process.env.OPENCODE_GO_WORKSPACE_ID = "ws-1"
    fetchSpy.mockImplementation(async () => htmlResponse(LEGACY_HTML))

    await fetchGoQuota()

    // `foo` is not a known auth/session cookie name, so the pair is treated as
    // an opaque value and prefixed rather than preserved.
    const [, init] = fetchSpy.mock.calls[0] as [string, any]
    expect(init.headers.Cookie).toBe("auth=foo=bar")
  })

  it("returns null when the page redirects (login bounce)", async () => {
    useCookieAuth()
    process.env.OPENCODE_GO_WORKSPACE_ID = "ws-1"
    fetchSpy.mockImplementation(async () => htmlResponse("", { ok: false, status: 302 }))

    expect(await fetchGoQuota()).toBeNull()
  })

  it("returns null when the page looks like a login page", async () => {
    useCookieAuth()
    process.env.OPENCODE_GO_WORKSPACE_ID = "ws-1"
    fetchSpy.mockImplementation(async () =>
      htmlResponse("<html><title>Sign in to continue</title></html>"),
    )

    expect(await fetchGoQuota()).toBeNull()
  })

  it("returns null on a non-OK legacy response", async () => {
    useCookieAuth()
    process.env.OPENCODE_GO_WORKSPACE_ID = "ws-1"
    fetchSpy.mockImplementation(async () => htmlResponse("server error", { ok: false, status: 500 }))

    expect(await fetchGoQuota()).toBeNull()
  })

  it("drops a legacy window with a malformed usagePercent while keeping sibling windows", async () => {
    useCookieAuth()
    process.env.OPENCODE_GO_WORKSPACE_ID = "ws-1"
    fetchSpy.mockImplementation(async () =>
      htmlResponse(`
        <script>
          rollingUsage:$R[0]={status:"ok",usagePercent:"lots",resetInSec:60};
          weeklyUsage:$R[1]={status:"ok",usagePercent:15,resetInSec:60};
        </script>`),
    )

    const info = await fetchGoQuota()

    expect(info?.rolling).toBeNull()
    expect(info?.weekly).toEqual({ usagePercent: 15, resetInSec: 60 })
  })

  it("drops a legacy window with a missing resetInSec while keeping valid siblings", async () => {
    useCookieAuth()
    process.env.OPENCODE_GO_WORKSPACE_ID = "ws-1"
    fetchSpy.mockImplementation(async () =>
      htmlResponse(`
        <script>
          rollingUsage:$R[0]={status:"ok",usagePercent:10,resetInSec:60};
          weeklyUsage:$R[1]={status:"ok",usagePercent:20};
          monthlyUsage:$R[2]={status:"ok",usagePercent:30,resetInSec:120};
        </script>`),
    )

    const info = await fetchGoQuota()

    expect(info).toEqual({
      rolling: { usagePercent: 10, resetInSec: 60 },
      weekly: null,
      monthly: { usagePercent: 30, resetInSec: 120 },
    })
  })

  it("drops a legacy window with a non-numeric resetInSec while keeping valid siblings", async () => {
    useCookieAuth()
    process.env.OPENCODE_GO_WORKSPACE_ID = "ws-1"
    fetchSpy.mockImplementation(async () =>
      htmlResponse(`
        <script>
          rollingUsage:$R[0]={status:"ok",usagePercent:10,resetInSec:60};
          weeklyUsage:$R[1]={status:"ok",usagePercent:20,resetInSec:"soon"};
          monthlyUsage:$R[2]={status:"ok",usagePercent:30,resetInSec:120};
        </script>`),
    )

    const info = await fetchGoQuota()

    expect(info).toEqual({
      rolling: { usagePercent: 10, resetInSec: 60 },
      weekly: null,
      monthly: { usagePercent: 30, resetInSec: 120 },
    })
  })

  it("drops legacy windows with non-finite resetInSec values while keeping valid siblings", async () => {
    useCookieAuth()
    process.env.OPENCODE_GO_WORKSPACE_ID = "ws-1"
    fetchSpy.mockImplementation(async () =>
      htmlResponse(`
        <script>
          rollingUsage:$R[0]={status:"ok",usagePercent:10,resetInSec:60};
          weeklyUsage:$R[1]={status:"ok",usagePercent:20,resetInSec:1e999};
          monthlyUsage:$R[2]={status:"ok",usagePercent:30,resetInSec:-1e999};
        </script>`),
    )

    const info = await fetchGoQuota()

    expect(info).toEqual({
      rolling: { usagePercent: 10, resetInSec: 60 },
      weekly: null,
      monthly: null,
    })
  })

  it("drops a legacy window with a null resetInSec while keeping valid siblings", async () => {
    useCookieAuth()
    process.env.OPENCODE_GO_WORKSPACE_ID = "ws-1"
    fetchSpy.mockImplementation(async () =>
      htmlResponse(`
        <script>
          rollingUsage:$R[0]={status:"ok",usagePercent:10,resetInSec:60};
          weeklyUsage:$R[1]={status:"ok",usagePercent:20,resetInSec:null};
          monthlyUsage:$R[2]={status:"ok",usagePercent:30,resetInSec:120};
        </script>`),
    )

    const info = await fetchGoQuota()

    expect(info).toEqual({
      rolling: { usagePercent: 10, resetInSec: 60 },
      weekly: null,
      monthly: { usagePercent: 30, resetInSec: 120 },
    })
  })

  it("returns null when every legacy window has an invalid resetInSec", async () => {
    useCookieAuth()
    process.env.OPENCODE_GO_WORKSPACE_ID = "ws-1"
    fetchSpy.mockImplementation(async () =>
      htmlResponse(`
        <script>
          rollingUsage:$R[0]={status:"ok",usagePercent:10};
          weeklyUsage:$R[1]={status:"ok",usagePercent:20,resetInSec:"soon"};
          monthlyUsage:$R[2]={status:"ok",usagePercent:30,resetInSec:null};
        </script>`),
    )

    expect(await fetchGoQuota()).toBeNull()
  })

  it("preserves a valid legacy resetInSec of 0 while dropping a malformed sibling", async () => {
    useCookieAuth()
    process.env.OPENCODE_GO_WORKSPACE_ID = "ws-1"
    fetchSpy.mockImplementation(async () =>
      htmlResponse(`
        <script>
          rollingUsage:$R[0]={status:"ok",usagePercent:5,resetInSec:0};
          weeklyUsage:$R[1]={status:"ok",usagePercent:10,resetInSec:"nope"};
          monthlyUsage:$R[2]={status:"ok",usagePercent:15,resetInSec:45};
        </script>`),
    )

    const info = await fetchGoQuota()

    expect(info).toEqual({
      rolling: { usagePercent: 5, resetInSec: 0 },
      weekly: null,
      monthly: { usagePercent: 15, resetInSec: 45 },
    })
    expect(info?.rolling?.resetInSec).toBe(0)
  })

  it("rejects legacy windows with out-of-range percent or unknown status", async () => {
    useCookieAuth()
    process.env.OPENCODE_GO_WORKSPACE_ID = "ws-1"
    fetchSpy.mockImplementation(async () =>
      htmlResponse(`
        <script>
          rollingUsage:$R[0]={status:"ok",usagePercent:150,resetInSec:60};
          weeklyUsage:$R[1]={status:"bogus",usagePercent:20,resetInSec:60};
          monthlyUsage:$R[2]={status:"rate-limited",usagePercent:30,resetInSec:60};
        </script>`),
    )

    const info = await fetchGoQuota()

    expect(info).toEqual({
      rolling: null,
      weekly: null,
      monthly: { usagePercent: 30, resetInSec: 60 },
    })
  })

  it("returns null when the HTML contains no parseable quota", async () => {
    useCookieAuth()
    process.env.OPENCODE_GO_WORKSPACE_ID = "ws-1"
    fetchSpy.mockImplementation(async () => htmlResponse(""))

    expect(await fetchGoQuota()).toBeNull()
  })
})

// ─── fetchQuotaInfo regression ────────────────────────────────────────────────

describe("fetchQuotaInfo", () => {
  it("parses a paid AI-credits snapshot", async () => {
    fetchSpy.mockImplementation(async () =>
      jsonResponse({
        copilot_plan: "business",
        quota_snapshots: {
          premium_models: {
            percent_remaining: 88,
            entitlement: 100,
            remaining: 88,
            overage_count: 2,
            overage_permitted: true,
            unlimited: false,
            token_based_billing: true,
          },
        },
      }),
    )

    const info = await fetchQuotaInfo("token")

    expect(info).toMatchObject({
      percentRemaining: 88,
      entitlement: 100,
      remaining: 88,
      overageCount: 2,
      overagePermitted: true,
      planType: "paid",
      quotaType: "ai_credits",
    })

    const [url, init] = fetchSpy.mock.calls[0] as [string, any]
    expect(url).toBe("https://api.github.com/copilot_internal/user")
    expect(init.headers.Authorization).toBe("Bearer token")
  })

  it("parses a free-plan chat quota", async () => {
    fetchSpy.mockImplementation(async () =>
      jsonResponse({
        copilot_plan: "free",
        limited_user_quotas: { chat: 30 },
        monthly_quotas: { chat: 60 },
      }),
    )

    const info = await fetchQuotaInfo("token")

    expect(info).toMatchObject({
      percentRemaining: 50,
      entitlement: 60,
      remaining: 30,
      planType: "free",
      quotaType: "premium",
    })
  })

  it("returns null on a non-OK response", async () => {
    fetchSpy.mockImplementation(async () => jsonResponse({}, { ok: false, status: 401 }))

    expect(await fetchQuotaInfo("token")).toBeNull()
  })
})
