import { htmlToText } from "./html"
import { capText, withTimeout } from "./util"

/** One search hit, normalized across every backend. */
export interface WebHit {
  title: string
  url: string
  snippet: string
  /** ISO date when the backend supplies one (brave.page_age, exa.publishedDate). */
  published?: string
  /** Backend relevance score, 0..1, when available (tavily.score). */
  score?: number
}

export interface SearchOptions {
  maxResults: number
  includeDomains?: string[]
  excludeDomains?: string[]
  signal?: AbortSignal
}

export interface SearchResult {
  hits: WebHit[]
  answer?: string
  costUSD?: number
}

export type SearchBackendName = "tavily" | "brave" | "exa" | "ddg"

export interface SearchBackend {
  readonly name: SearchBackendName
  search(query: string, opts: SearchOptions): Promise<SearchResult>
}

const SEARCH_TIMEOUT_MS = 10_000
const SNIPPET_CAP_CHARS = 300

export interface KeyedBackendOptions {
  apiKey: string
  fetchFn?: typeof fetch
  timeoutMs?: number
}

/** POST api.tavily.com/search - recommended primary. */
export function tavilySearchBackend(opts: KeyedBackendOptions): SearchBackend {
  const fetchFn = opts.fetchFn ?? fetch
  return {
    name: "tavily",
    async search(query, searchOpts) {
      const signal = withTimeout(searchOpts.signal, opts.timeoutMs ?? SEARCH_TIMEOUT_MS)
      const response = await fetchFn("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify({
          query,
          max_results: searchOpts.maxResults,
          search_depth: "basic",
          topic: "general",
          include_answer: false,
          include_raw_content: false,
          include_images: false,
          ...(searchOpts.includeDomains?.length
            ? { include_domains: searchOpts.includeDomains }
            : {}),
          ...(searchOpts.excludeDomains?.length
            ? { exclude_domains: searchOpts.excludeDomains }
            : {}),
        }),
        signal,
      })
      if (!response.ok) throw new Error(`tavily search failed (HTTP ${response.status})`)
      const body = (await response.json()) as {
        results?: { title: string; url: string; content: string; score?: number }[]
        answer?: string
      }
      const hits: WebHit[] = (body.results ?? []).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: capText(r.content ?? "", SNIPPET_CAP_CHARS),
        ...(r.score !== undefined ? { score: r.score } : {}),
      }))
      return { hits, ...(body.answer ? { answer: body.answer } : {}) }
    },
  }
}

/** GET api.search.brave.com/res/v1/web/search - strong alternate, SERP-shaped snippets. */
export function braveSearchBackend(opts: KeyedBackendOptions): SearchBackend {
  const fetchFn = opts.fetchFn ?? fetch
  return {
    name: "brave",
    async search(query, searchOpts) {
      const signal = withTimeout(searchOpts.signal, opts.timeoutMs ?? SEARCH_TIMEOUT_MS)
      const params = new URLSearchParams({
        q: query,
        count: String(searchOpts.maxResults),
        text_decorations: "false",
        extra_snippets: "true",
      })
      const response = await fetchFn(`https://api.search.brave.com/res/v1/web/search?${params}`, {
        headers: { accept: "application/json", "x-subscription-token": opts.apiKey },
        signal,
      })
      if (!response.ok) throw new Error(`brave search failed (HTTP ${response.status})`)
      const body = (await response.json()) as {
        web?: {
          results?: {
            title: string
            url: string
            description?: string
            page_age?: string
            extra_snippets?: string[]
          }[]
        }
      }
      const hits: WebHit[] = (body.web?.results ?? []).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: capText(r.extra_snippets?.join(" ") || r.description || "", SNIPPET_CAP_CHARS),
        ...(r.page_age ? { published: r.page_age } : {}),
      }))
      return { hits }
    },
  }
}

/** POST api.exa.ai/search - alternate; exact per-call cost telemetry (costDollars.total). */
export function exaSearchBackend(opts: KeyedBackendOptions): SearchBackend {
  const fetchFn = opts.fetchFn ?? fetch
  return {
    name: "exa",
    async search(query, searchOpts) {
      const signal = withTimeout(searchOpts.signal, opts.timeoutMs ?? SEARCH_TIMEOUT_MS)
      const response = await fetchFn("https://api.exa.ai/search", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": opts.apiKey },
        body: JSON.stringify({
          query,
          numResults: searchOpts.maxResults,
          type: "auto",
          contents: { text: { maxCharacters: 600 } },
        }),
        signal,
      })
      if (!response.ok) throw new Error(`exa search failed (HTTP ${response.status})`)
      const body = (await response.json()) as {
        results?: { title?: string; url: string; text?: string; publishedDate?: string }[]
        costDollars?: { total?: number }
      }
      const hits: WebHit[] = (body.results ?? []).map((r) => ({
        title: r.title ?? r.url,
        url: r.url,
        snippet: capText(r.text ?? "", SNIPPET_CAP_CHARS),
        ...(r.publishedDate ? { published: r.publishedDate } : {}),
      }))
      return {
        hits,
        ...(body.costDollars?.total !== undefined ? { costUSD: body.costDollars.total } : {}),
      }
    },
  }
}

export interface DdgBackendOptions {
  fetchFn?: typeof fetch
  timeoutMs?: number
}

const DDG_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
const RESULT_LINK_RE = /<a rel="nofollow" href="([^"]+)" class='result-link'>([\s\S]*?)<\/a>/g
const RESULT_SNIPPET_RE = /<td class='result-snippet'>([\s\S]*?)<\/td>/g

function parseDdgLiteHtml(html: string): WebHit[] {
  const links = [...html.matchAll(RESULT_LINK_RE)].map((m) => ({
    url: htmlToText(m[1] ?? ""),
    title: htmlToText(m[2] ?? ""),
  }))
  const snippets = [...html.matchAll(RESULT_SNIPPET_RE)].map((m) => htmlToText(m[1] ?? ""))
  return links.map((link, i) => ({
    title: link.title,
    url: link.url,
    snippet: capText(snippets[i] ?? "", SNIPPET_CAP_CHARS),
  }))
}

/**
 * POST lite.duckduckgo.com/lite/ - keyless last-resort fallback with no SLA.
 * One request, no retry on 202 (DuckDuckGo's rate-limit page), 8s timeout.
 */
export function ddgSearchBackend(opts: DdgBackendOptions = {}): SearchBackend {
  const fetchFn = opts.fetchFn ?? fetch
  return {
    name: "ddg",
    async search(query, searchOpts) {
      const signal = withTimeout(searchOpts.signal, opts.timeoutMs ?? 8_000)
      const response = await fetchFn("https://lite.duckduckgo.com/lite/", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": DDG_USER_AGENT,
        },
        body: new URLSearchParams({ q: query }).toString(),
        signal,
      })
      if (response.status === 202) {
        throw new Error(
          "duckduckgo rate-limited (HTTP 202) - configure web.tavily or web.brave for a reliable backend",
        )
      }
      if (!response.ok) throw new Error(`duckduckgo search failed (HTTP ${response.status})`)
      const html = await response.text()
      return { hits: parseDdgLiteHtml(html).slice(0, searchOpts.maxResults) }
    },
  }
}
