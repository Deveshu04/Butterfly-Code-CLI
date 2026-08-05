import { z } from "zod"
import type { ButterflyConfig } from "../config/config"
import type { ToolDefinition } from "../tool/registry"
import {
  braveSearchBackend,
  ddgSearchBackend,
  exaSearchBackend,
  type SearchBackend,
  tavilySearchBackend,
  type WebHit,
} from "./backends"
import {
  type FetchBackend,
  jinaFetchBackend,
  rawFetchBackend,
  tavilyExtractBackend,
} from "./extract"
import { SsrfError, type ValidateFetchUrlOptions, validateFetchUrl } from "./ssrf"

export const webToolInput = z.object({
  op: z.enum(["search", "fetch"]),
  query: z.string().optional().describe("Search query (op=search)"),
  url: z.string().optional().describe("Absolute URL to read (op=fetch)"),
  maxResults: z.number().int().min(1).max(10).optional().describe("Default 5 (op=search)"),
  includeDomains: z.array(z.string()).optional(),
  excludeDomains: z.array(z.string()).optional(),
})

export type WebConfig = NonNullable<ButterflyConfig["web"]>

export interface WebBackends {
  searchChain: SearchBackend[]
  fetchChain: FetchBackend[]
}

const DEFAULT_MAX_RESULTS = 5
const DEFAULT_MAX_FETCH_CHARS = 20_000
const SEARCH_BLOCK_CAP_CHARS = 4_000
const CAPTURE_CHARS = 200_000

const SEARCH_PROVIDERS = ["tavily", "brave", "exa"] as const

/**
 * The host each backend hands the query/URL to. `raw` is the direct request to
 * the target itself, so it contributes no third party.
 */
const TRANSIT_HOST: Record<string, string> = {
  tavily: "api.tavily.com",
  brave: "api.search.brave.com",
  exa: "api.exa.ai",
  ddg: "lite.duckduckgo.com",
  jina: "r.jina.ai",
  raw: "",
}

function transitHosts(chain: { readonly name: string }[]): string[] {
  return chain.map((backend) => TRANSIT_HOST[backend.name] ?? backend.name).filter(Boolean)
}

const SECRET_QUERY_KEYS = new Set([
  "sig",
  "signature",
  "token",
  "access_token",
  "id_token",
  "refresh_token",
  "auth",
  "auth_token",
  "authorization",
  "api_key",
  "apikey",
  "key",
  "secret",
  "client_secret",
  "password",
  "passwd",
  "pwd",
  "credential",
  "credentials",
  "sas",
  "session",
  "sessionid",
  "session_id",
  "jwt",
])
const SECRET_QUERY_PREFIXES = ["x-amz-", "x-goog-", "x-ms-", "x-sas-"]

export function looksCredentialBearing(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.username || parsed.password) return true
  for (const rawKey of parsed.searchParams.keys()) {
    const key = rawKey.toLowerCase()
    if (SECRET_QUERY_KEYS.has(key)) return true
    if (SECRET_QUERY_PREFIXES.some((prefix) => key.startsWith(prefix))) return true
  }
  return false
}

/** Credential-bearing URLs are fetched directly, never proxied through a reader. */
function effectiveFetchChain(chain: FetchBackend[], url: string): FetchBackend[] {
  if (!looksCredentialBearing(url)) return chain
  return chain.filter((backend) => backend.name === "raw")
}

export function buildWebBackends(
  config: WebConfig | undefined,
  opts: { fetchFn?: typeof fetch; resolveHost?: ValidateFetchUrlOptions["resolveHost"] } = {},
): WebBackends {
  const fetchFn = opts.fetchFn
  const allowDdg = config?.allowDuckDuckGo ?? true

  const build: Record<(typeof SEARCH_PROVIDERS)[number] | "ddg", () => SearchBackend | undefined> =
    {
      tavily: () =>
        config?.tavily?.apiKey
          ? tavilySearchBackend({ apiKey: config.tavily.apiKey, fetchFn })
          : undefined,
      brave: () =>
        config?.brave?.apiKey
          ? braveSearchBackend({ apiKey: config.brave.apiKey, fetchFn })
          : undefined,
      exa: () =>
        config?.exa?.apiKey ? exaSearchBackend({ apiKey: config.exa.apiKey, fetchFn }) : undefined,
      ddg: () => (allowDdg ? ddgSearchBackend({ fetchFn }) : undefined),
    }

  const searchChain: SearchBackend[] = []
  if (config?.provider) {
    const backend = build[config.provider as keyof typeof build]?.()
    if (backend) searchChain.push(backend)
  } else {
    for (const provider of SEARCH_PROVIDERS) {
      const backend = build[provider]()
      if (backend) searchChain.push(backend)
    }
    const ddg = build.ddg()
    if (ddg) searchChain.push(ddg)
  }

  const fetchChain: FetchBackend[] = []
  if (config?.tavily?.apiKey) {
    fetchChain.push(tavilyExtractBackend({ apiKey: config.tavily.apiKey, fetchFn }))
  }
  const allowJina = config?.allowJina ?? config?.jinaKey !== undefined
  if (allowJina) fetchChain.push(jinaFetchBackend({ apiKey: config?.jinaKey, fetchFn }))
  fetchChain.push(rawFetchBackend({ fetchFn, resolveHost: opts.resolveHost }))

  return { searchChain, fetchChain }
}

function formatSearchOutput(hits: WebHit[], backend: string): string {
  if (hits.length === 0) return `No results (${backend}).`
  const lines = hits.map((hit, i) => `[${i + 1}] ${hit.title} — ${hit.url}\n    ${hit.snippet}`)
  let block = lines.join("\n")
  if (block.length > SEARCH_BLOCK_CAP_CHARS) {
    block = `${block.slice(0, SEARCH_BLOCK_CAP_CHARS)}\n[... truncated ...]`
  }
  return `${block}\n(${hits.length} result${hits.length === 1 ? "" : "s"} · ${backend})`
}

export interface CreateWebToolOptions {
  config: () => WebConfig | undefined
  fetchFn?: typeof fetch
  /** DNS resolver override for the SSRF guard (tests only; defaults to a real lookup). */
  resolveHost?: ValidateFetchUrlOptions["resolveHost"]
  /** Overrides web.maxResults; web.maxResults overrides the built-in default. */
  maxResults?: number
  /** Overrides web.maxFetchChars; web.maxFetchChars overrides the built-in default. */
  maxFetchChars?: number
}

export function createWebTool(
  opts: CreateWebToolOptions,
): ToolDefinition<z.infer<typeof webToolInput>> {
  const chainFor = () =>
    buildWebBackends(opts.config(), {
      ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
      ...(opts.resolveHost ? { resolveHost: opts.resolveHost } : {}),
    })

  return {
    name: "web",
    description:
      "Search the web or read a URL. op=search (query, maxResults, includeDomains, excludeDomains): ranked results as title, url, and a snippet. op=fetch (url): the page's readable text, truncated for length.",
    inputSchema: webToolInput,
    permissionTarget: (input) => {
      if (input.op !== "fetch" || !input.url) return undefined
      try {
        return new URL(input.url).host
      } catch {
        return undefined
      }
    },
    permissionNote: (input) => {
      const { searchChain, fetchChain } = chainFor()
      if (input.op === "search") {
        const hosts = transitHosts(searchChain)
        return hosts.length > 0 ? `via ${hosts.join(" → ")}` : undefined
      }
      if (!input.url) return undefined
      const effective = transitHosts(effectiveFetchChain(fetchChain, input.url))
      if (effective.length > 0) return `via ${effective.join(" → ")}`
      if (transitHosts(fetchChain).length > 0) return "direct only — URL looks credential-bearing"
      return undefined
    },
    async execute(input, ctx) {
      const config = opts.config()
      const { searchChain, fetchChain } = chainFor()
      const signal = ctx.signal
      const aborted = () =>
        signal?.aborted
          ? {
              output: `Web ${input.op} aborted before it completed.`,
              isError: true,
            }
          : undefined

      if (input.op === "search") {
        if (!input.query || input.query.trim() === "") {
          return { output: "search requires a non-empty query.", isError: true }
        }
        if (searchChain.length === 0) {
          return {
            output:
              "No web search backend configured. Set web.tavily.apiKey, web.brave.apiKey, or web.exa.apiKey in butterfly.jsonc (or leave web.allowDuckDuckGo enabled for the keyless fallback).",
            isError: true,
          }
        }
        const maxResults =
          input.maxResults ?? opts.maxResults ?? config?.maxResults ?? DEFAULT_MAX_RESULTS
        const started = Date.now()
        let lastError = ""
        for (const backend of searchChain) {
          try {
            const result = await backend.search(input.query, {
              maxResults,
              includeDomains: input.includeDomains,
              excludeDomains: input.excludeDomains,
              signal,
            })
            return {
              output: formatSearchOutput(result.hits, backend.name),
              meta: {
                op: "search",
                backend: backend.name,
                elapsedMs: Date.now() - started,
                hits: result.hits,
                ...(result.costUSD !== undefined ? { costUSD: result.costUSD } : {}),
              },
            }
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error)
            const abort = aborted()
            if (abort) return abort
          }
        }
        return {
          output: `Web search failed on every configured backend. Last error: ${lastError}`,
          isError: true,
        }
      }

      // op=fetch
      if (!input.url || input.url.trim() === "") {
        return { output: "fetch requires a url.", isError: true }
      }
      let validated: URL
      try {
        validated = await validateFetchUrl(input.url, { resolveHost: opts.resolveHost })
      } catch (error) {
        const message = error instanceof SsrfError ? error.message : `invalid url "${input.url}"`
        return { output: `Refused to fetch — ${message}.`, isError: true }
      }
      const target = validated.toString()
      const maxFetchChars = opts.maxFetchChars ?? config?.maxFetchChars ?? DEFAULT_MAX_FETCH_CHARS
      const started = Date.now()
      let lastError = ""
      for (const backend of effectiveFetchChain(fetchChain, target)) {
        try {
          const result = await backend.extract(target, { signal })
          const title = result.title ?? target
          const truncatedForModel = result.markdown.length > maxFetchChars
          const body = truncatedForModel
            ? `${result.markdown.slice(0, maxFetchChars)}\n[... truncated at ${maxFetchChars} chars ...]`
            : result.markdown
          return {
            output: `# ${title}\n${target}\n\n${body}`,
            meta: {
              op: "fetch",
              backend: backend.name,
              elapsedMs: Date.now() - started,
              url: target,
              title,
              text: result.markdown.slice(0, CAPTURE_CHARS),
              chars: result.markdown.length,
              truncatedForModel,
              ...(result.costUSD !== undefined ? { costUSD: result.costUSD } : {}),
            },
          }
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error)
          const abort = aborted()
          if (abort) return abort
        }
      }
      const jinaHint =
        transitHosts(fetchChain).includes("r.jina.ai") || looksCredentialBearing(target)
          ? ""
          : " Setting web.allowJina true adds the r.jina.ai reader as a fallback (it sends the URL to a third party)."
      return {
        output: `Fetch failed on every backend for ${target}. Last error: ${lastError}${jinaHint}`,
        isError: true,
      }
    },
  }
}
