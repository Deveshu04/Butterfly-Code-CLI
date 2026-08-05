import { extractTitle, htmlToText } from "./html"
import { type ValidateFetchUrlOptions, validateFetchUrl } from "./ssrf"
import { withTimeout } from "./util"

export interface FetchResult {
  markdown: string
  title?: string
  costUSD?: number
}

export type FetchBackendName = "tavily" | "jina" | "raw"

export interface FetchExtractOptions {
  signal?: AbortSignal
}

export interface FetchBackend {
  readonly name: FetchBackendName
  extract(url: string, opts: FetchExtractOptions): Promise<FetchResult>
}

export interface TavilyExtractOptions {
  apiKey: string
  fetchFn?: typeof fetch
  timeoutMs?: number
}

/** POST api.tavily.com/extract - covers op=fetch with the same key as search. */
export function tavilyExtractBackend(opts: TavilyExtractOptions): FetchBackend {
  const fetchFn = opts.fetchFn ?? fetch
  return {
    name: "tavily",
    async extract(url, extractOpts) {
      const signal = withTimeout(extractOpts.signal, opts.timeoutMs ?? 15_000)
      const response = await fetchFn("https://api.tavily.com/extract", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify({ urls: [url], format: "markdown", extract_depth: "basic" }),
        signal,
      })
      if (!response.ok) throw new Error(`tavily extract failed (HTTP ${response.status})`)
      const body = (await response.json()) as {
        results?: { url: string; raw_content?: string }[]
        failed_results?: { url: string; error: string }[]
      }
      const hit = body.results?.[0]
      if (!hit?.raw_content) {
        const failure = body.failed_results?.[0]
        throw new Error(`tavily extract returned no content${failure ? `: ${failure.error}` : ""}`)
      }
      return { markdown: hit.raw_content }
    },
  }
}

const JINA_MARKDOWN_MARKER = "Markdown Content:"

function parseJinaReader(text: string): { title?: string; markdown: string } {
  const titleMatch = /^Title:\s*(.*)$/m.exec(text)
  const markerIndex = text.indexOf(JINA_MARKDOWN_MARKER)
  const markdown =
    markerIndex === -1 ? text.trim() : text.slice(markerIndex + JINA_MARKDOWN_MARKER.length).trim()
  const title = titleMatch?.[1]?.trim()
  return { markdown, ...(title ? { title } : {}) }
}

export interface JinaFetchOptions {
  apiKey?: string
  fetchFn?: typeof fetch
  timeoutMs?: number
}

/** GET r.jina.ai/<url> - keyless (rate-limited) op=fetch fallback; optional Bearer key raises the limit. */
export function jinaFetchBackend(opts: JinaFetchOptions = {}): FetchBackend {
  const fetchFn = opts.fetchFn ?? fetch
  return {
    name: "jina",
    async extract(url, extractOpts) {
      const signal = withTimeout(extractOpts.signal, opts.timeoutMs ?? 20_000)
      const response = await fetchFn(`https://r.jina.ai/${url}`, {
        headers: opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {},
        signal,
      })
      if (!response.ok) throw new Error(`jina fetch failed (HTTP ${response.status})`)
      const text = await response.text()
      return parseJinaReader(text)
    },
  }
}

export interface RawFetchOptions {
  fetchFn?: typeof fetch
  timeoutMs?: number
  /** Hard cap on downloaded body bytes; enforced while streaming, not after. */
  maxBytes?: number
  maxRedirects?: number
  resolveHost?: ValidateFetchUrlOptions["resolveHost"]
}

const DEFAULT_MAX_BYTES = 2_000_000
const DEFAULT_MAX_REDIRECTS = 5

async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) {
    const text = await response.text()
    return text.length > maxBytes
      ? { text: text.slice(0, maxBytes), truncated: true }
      : { text, truncated: false }
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let received = 0
  let out = ""
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > maxBytes) {
      const allowed = Math.max(0, value.byteLength - (received - maxBytes))
      out += decoder.decode(value.subarray(0, allowed), { stream: true })
      truncated = true
      try {
        await reader.cancel()
      } catch {
        // best-effort - the cap already did its job
      }
      break
    }
    out += decoder.decode(value, { stream: true })
  }
  out += decoder.decode()
  return { text: out, truncated }
}

function looksLikeHtml(contentType: string, body: string): boolean {
  if (contentType.includes("html")) return true
  return /^\s*<(!doctype html|html)/i.test(body.slice(0, 200))
}

/**
 * Direct HTTP GET + our own readability-lite strip - the fully offline
 * fallback with no third party. Manually walks redirects (`redirect:
 * "manual"`) so the SSRF guard runs on every hop, not just the first URL.
 */
export function rawFetchBackend(opts: RawFetchOptions = {}): FetchBackend {
  const fetchFn = opts.fetchFn ?? fetch
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  return {
    name: "raw",
    async extract(inputUrl, extractOpts) {
      const signal = withTimeout(extractOpts.signal, opts.timeoutMs ?? 20_000)
      let current = await validateFetchUrl(inputUrl, { resolveHost: opts.resolveHost })
      for (let hop = 0; ; hop++) {
        if (hop > maxRedirects) throw new Error(`too many redirects fetching ${inputUrl}`)
        const response = await fetchFn(current.toString(), { redirect: "manual", signal })
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location")
          if (!location)
            throw new Error(`redirect from ${current.toString()} had no Location header`)
          const next = new URL(location, current)
          current = await validateFetchUrl(next.toString(), { resolveHost: opts.resolveHost })
          continue
        }
        if (!response.ok)
          throw new Error(`fetch failed (HTTP ${response.status}) for ${current.toString()}`)
        const { text: body, truncated } = await readCapped(response, maxBytes)
        const contentType = response.headers.get("content-type") ?? ""
        const isHtml = looksLikeHtml(contentType, body)
        const title = isHtml ? extractTitle(body) : undefined
        let markdown = isHtml ? htmlToText(body) : body
        if (truncated)
          markdown = `${markdown}\n[... truncated: response exceeded ${maxBytes} bytes ...]`
        return { markdown, ...(title ? { title } : {}) }
      }
    },
  }
}
