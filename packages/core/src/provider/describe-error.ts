import { APICallError, RetryError } from "ai"


export type ProviderErrorKind =
  | "rate_limit"
  | "quota"
  | "auth"
  | "context_length"
  | "unavailable"
  | "timeout"
  | "network"
  | "bad_request"
  | "unknown"

export interface ProviderErrorInfo {
  kind: ProviderErrorKind
  message: string
  status?: number
  provider?: string
  retryAfterSec?: number
  detail?: string
}

export const RETRYABLE_ERROR_KINDS: ReadonlySet<ProviderErrorKind> = new Set([
  "rate_limit",
  "unavailable",
  "timeout",
  "network",
])

export function isRetryableProviderError(kind: ProviderErrorKind): boolean {
  return RETRYABLE_ERROR_KINDS.has(kind)
}

const DETAIL_CAP = 300

const CONTEXT_LENGTH_TEXT_RE =
  /context[ _-]?length|context window|context limit|maximum context|too many tokens|reduce the length|(?:prompt|input|message|request)s?\s+(?:is|are)\s+too long|too long:\s*\d|exceed(?:s|ed)?\s+(?:the\s+)?(?:maximum|max\b|model'?s|context\b|token)/i

function classifyByTypeText(
  type: string | undefined,
  code: string | undefined,
): ProviderErrorKind | undefined {
  const t = `${type ?? ""} ${code ?? ""}`.trim().toLowerCase()
  if (t === "") return undefined
  if (/authentication_error|invalid_api_key|unauthorized/.test(t)) return "auth"
  if (/permission_error|forbidden/.test(t)) return "auth"
  if (/insufficient_quota|billing/.test(t)) return "quota"
  if (/\bquota\b/.test(t)) return "quota"
  if (/rate_limit/.test(t)) return "rate_limit"
  if (/overloaded|service_unavailable|\bunavailable\b/.test(t)) return "unavailable"
  if (CONTEXT_LENGTH_TEXT_RE.test(t)) return "context_length"
  if (/invalid_request_error|invalid_argument|bad_request/.test(t)) return "bad_request"
  return undefined
}

interface ExtractedBody {
  message?: string
  type?: string
  code?: string
}

function extractFromBody(value: unknown, depth = 0): ExtractedBody | undefined {
  if (depth > 4 || value === null || typeof value !== "object") return undefined
  const rec = value as Record<string, unknown>

  const nested = rec.error
  if (typeof nested === "object" && nested !== null) {
    const inner = extractFromBody(nested, depth + 1)
    if (inner?.message !== undefined) return inner
  } else if (typeof nested === "string" && rec.message === undefined) {
    return { message: nested }
  }

  const message =
    typeof rec.message === "string"
      ? rec.message
      : typeof rec.detail === "string"
        ? rec.detail
        : undefined
  const type = typeof rec.type === "string" ? rec.type : undefined
  const code =
    typeof rec.code === "string"
      ? rec.code
      : typeof rec.code === "number"
        ? String(rec.code)
        : undefined

  if (message === undefined && type === undefined && code === undefined) return undefined
  return { message, type, code }
}

function extractStatus(value: unknown): number | undefined {
  if (value === null || typeof value !== "object") return undefined
  const rec = value as Record<string, unknown>
  if (typeof rec.status === "number") return rec.status
  if (typeof rec.statusCode === "number") return rec.statusCode
  return undefined
}

function parseRetryAfterSec(headers: Record<string, string> | undefined): number | undefined {
  const raw = headers?.["retry-after"]
  if (raw === undefined) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds))
  const dateMs = Date.parse(raw)
  if (!Number.isNaN(dateMs)) return Math.max(0, Math.round((dateMs - Date.now()) / 1000))
  return undefined
}

function capText(text: string, cap = DETAIL_CAP): string {
  return text.length > cap ? `${text.slice(0, cap)}…` : text
}

function buildDetail(message: string, type?: string, code?: string): string | undefined {
  const tags: string[] = []
  const seen = new Set<string>()
  for (const raw of [type, code]) {
    const tag = typeof raw === "string" ? raw.trim() : ""
    if (tag === "") continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    tags.push(tag)
  }
  if (tags.length === 0) return undefined

  const human = message.trim()
  const lower = human.toLowerCase()
  const extra = tags.filter((tag) => !lower.includes(tag.toLowerCase()))
  if (human === "") return extra.length > 0 ? capText(extra.join(" ")) : undefined
  return capText(extra.length > 0 ? `${human} (${extra.join(" ")})` : human)
}

function safeStringifyCapped(value: unknown, cap = DETAIL_CAP): string {
  const seen = new WeakSet<object>()
  try {
    const json = JSON.stringify(value, (_key, v) => {
      if (typeof v === "bigint") return `${v}n`
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[Circular]"
        seen.add(v)
      }
      return v
    })
    if (json !== undefined) return capText(json, cap)
  } catch {
    // fall through to the descriptive fallback below
  }
  return "unclassifiable provider error (unable to serialize)"
}

function classifyByShape(params: {
  status?: number
  message: string
  type?: string
  code?: string
  retryAfterSec?: number
}): ProviderErrorInfo {
  const { status, message, type, code, retryAfterSec } = params
  const typeKind = classifyByTypeText(type, code)
  const messageSaysContext = CONTEXT_LENGTH_TEXT_RE.test(message)
  const detailText = buildDetail(message, type, code)

  const base: ProviderErrorInfo = {
    kind: "unknown",
    message,
    ...(status !== undefined ? { status } : {}),
    ...(detailText !== undefined ? { detail: detailText } : {}),
  }
  const withRetry: ProviderErrorInfo =
    retryAfterSec !== undefined ? { ...base, retryAfterSec } : base

  if (status === 413) return { ...base, kind: "context_length" }
  if (status === 401 || status === 403) return { ...base, kind: "auth" }
  if (status === 402) return { ...base, kind: "quota" }
  if (status === 408) return { ...base, kind: "timeout" }
  if (status === 429) return { ...withRetry, kind: typeKind === "quota" ? "quota" : "rate_limit" }
  if (status !== undefined && status >= 500 && status < 600) {
    return { ...base, kind: typeKind === "context_length" ? "context_length" : "unavailable" }
  }

  if (typeKind !== undefined) {
    if (typeKind === "bad_request" && messageSaysContext) {
      return { ...base, kind: "context_length" }
    }
    return typeKind === "rate_limit"
      ? { ...withRetry, kind: "rate_limit" }
      : { ...base, kind: typeKind }
  }
  // 413/422 too: Sarvam's gateway reports an overflow as 422 "… exceeds the
  // model context window of N tokens", and some proxies use 413.
  if (
    (status === undefined || status === 400 || status === 413 || status === 422) &&
    messageSaysContext
  ) {
    return { ...base, kind: "context_length" }
  }
  if (status !== undefined && status >= 400 && status < 500) return { ...base, kind: "bad_request" }
  if (status === undefined && /timeout/i.test(message)) return { ...base, kind: "timeout" }
  if (status === undefined) return { ...base, kind: "network" }
  return base
}

function classifyApiCallError(error: APICallError): ProviderErrorInfo {
  const body = error.data ?? tryParseJson(error.responseBody)
  const extracted = extractFromBody(body)
  const message = extracted?.message ?? error.message ?? "provider error"
  const retryAfterSec = parseRetryAfterSec(error.responseHeaders)
  return classifyByShape({
    status: error.statusCode,
    message,
    type: extracted?.type,
    code: extracted?.code,
    retryAfterSec,
  })
}

function tryParseJson(text: string | undefined): unknown {
  if (text === undefined || text.trim() === "") return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function classifyProviderError(error: unknown): ProviderErrorInfo {
  if (error === null || error === undefined) {
    return { kind: "unknown", message: "unknown provider error (no details)" }
  }

  if (error instanceof RetryError) {
    const last = error.errors.length > 0 ? error.errors[error.errors.length - 1] : undefined
    return classifyProviderError(last ?? error.message)
  }

  if (APICallError.isInstance(error)) {
    return classifyApiCallError(error)
  }

  if (error instanceof Error) {
    if (error.name === "TimeoutError") return { kind: "timeout", message: error.message }
    if (/tool result is missing for tool call/i.test(error.message)) {
      return { kind: "bad_request", message: error.message }
    }
    return { kind: "unknown", message: error.message !== "" ? error.message : error.toString() }
  }

  if (typeof error === "string") {
    return { kind: "unknown", message: error }
  }

  if (typeof error === "object") {
    const extracted = extractFromBody(error)
    if (extracted?.message !== undefined) {
      return classifyByShape({
        status: extractStatus(error),
        message: extracted.message,
        type: extracted.type,
        code: extracted.code,
      })
    }
    return { kind: "unknown", message: safeStringifyCapped(error) }
  }

  return { kind: "unknown", message: safeStringifyCapped(error) }
}

export function describeProviderError(info: ProviderErrorInfo): string {
  const status = info.status !== undefined ? ` (${info.status})` : ""
  switch (info.kind) {
    case "rate_limit": {
      const who = info.provider !== undefined ? ` by ${info.provider}` : ""
      const retry = info.retryAfterSec !== undefined ? ` — retry in ~${info.retryAfterSec}s` : ""
      return `rate limited${who}${retry}${status}`
    }
    case "quota": {
      const detail = info.detail ?? info.message
      return `quota/billing exhausted${status}${detail !== "" ? `: ${detail}` : ""}`
    }
    case "auth":
      return `invalid or missing API key${status} — /provider to update it`
    case "unavailable":
      return `provider unavailable/overloaded${status} — try again shortly`
    case "context_length":
      return "context window exceeded — /compact or a smaller task"
    case "timeout":
      return `request timed out${status} — try again`
    case "network":
      return "network error reaching the provider — check connectivity and try again"
    case "bad_request":
      return `provider rejected the request${status}: ${info.message}`
    case "unknown":
      return `unknown provider error: ${info.message}`
    default: {
      const _exhaustive: never = info.kind
      return `unknown provider error: ${info.message ?? String(_exhaustive)}`
    }
  }
}
