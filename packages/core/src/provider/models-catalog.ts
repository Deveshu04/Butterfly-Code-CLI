import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export interface CatalogEntry {
  context: number
  output?: number
  toolCall?: boolean
  /** From models.dev `modalities.input`. Undefined when unknown; treat it
   * as false. */
  imageInput?: boolean
  cost?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
  }
}

export interface CatalogLoadOptions {
  cachePath: string
  fetchFn?: typeof fetch
  /** Refresh the disk cache when older than this. Default 24h. */
  maxAgeMs?: number
  now?: () => number
  /** Never fetch or write the cache; use whatever is on disk, even stale. */
  cacheOnly?: boolean
}

export type CatalogCacheStatus = "fresh" | "stale" | "missing"

/** On-disk freshness probe that never fetches. */
export function catalogCacheStatus(
  cachePath: string,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
  now: () => number = Date.now,
): CatalogCacheStatus {
  const cached = readCache(cachePath)
  if (!cached) return "missing"
  return now() - cached.fetchedAt < maxAgeMs ? "fresh" : "stale"
}

export const MODELS_DEV_URL = "https://models.dev/api.json"

/**
 * Offline fallback used only when the models.dev snapshot has no row.
 * Sarvam output caps leave room under its prompt+max_tokens <= context rule;
 * pricing is converted from published INR rates at ~96 INR/USD.
 */
/** Providers whose model ids belong to OTHER vendors (resolved via lookupAcross). */
export const GATEWAY_PROVIDERS: ReadonlySet<string> = new Set(["litellm"])

export const BUILTIN_MODELS: Record<string, Record<string, CatalogEntry>> = {
  sarvam: {
    "sarvam-105b": {
      context: 128_000,
      output: 16_384,
      toolCall: true,
      imageInput: false,
      cost: { input: 0.305, output: 0.763, cacheRead: 0.114 },
    },
    "sarvam-105b-conversations": {
      context: 32_000,
      output: 8_192,
      toolCall: true,
      imageInput: false,
      cost: { input: 0.305, output: 0.763, cacheRead: 0.114 },
    },
    "sarvam-30b": { context: 64_000, output: 8_192, toolCall: true, imageInput: false },
  },
}

/** Live local-model listing straight from the Ollama daemon. */
export async function fetchOllamaModels(
  baseURL = "http://localhost:11434",
  fetchFn: typeof fetch = fetch,
): Promise<string[]> {
  try {
    const response = await fetchFn(`${baseURL}/api/tags`)
    if (!response.ok) return []
    const data = (await response.json()) as { models?: { name: string }[] }
    return (data.models ?? []).map((model) => model.name).sort()
  } catch {
    return []
  }
}
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000

interface CacheFile {
  fetchedAt: number
  data: Record<string, unknown>
}

function readCache(path: string): CacheFile | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CacheFile
    if (typeof parsed?.fetchedAt === "number" && parsed.data) return parsed
  } catch {
    // missing or corrupt cache
  }
  return undefined
}

/**
 * models.dev snapshot, disk-cached with age-based refresh and stale-on-error.
 * Supplies per-model context limits and pricing.
 */
export class ModelsCatalog {
  private constructor(private data: Record<string, unknown>) {}

  static async load(opts: CatalogLoadOptions): Promise<ModelsCatalog> {
    const fetchFn = opts.fetchFn ?? fetch
    const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS
    const now = opts.now ?? Date.now

    const cached = readCache(opts.cachePath)
    if (opts.cacheOnly) {
      return new ModelsCatalog(cached?.data ?? {})
    }
    if (cached && now() - cached.fetchedAt < maxAgeMs) {
      return new ModelsCatalog(cached.data)
    }

    try {
      const response = await fetchFn(MODELS_DEV_URL)
      if (!response.ok) throw new Error(`models.dev returned ${response.status}`)
      const data = (await response.json()) as Record<string, unknown>
      mkdirSync(dirname(opts.cachePath), { recursive: true })
      writeFileSync(opts.cachePath, JSON.stringify({ fetchedAt: now(), data } satisfies CacheFile))
      return new ModelsCatalog(data)
    } catch {
      // Offline or rate-limited: stale beats empty, empty beats crashing.
      return new ModelsCatalog(cached?.data ?? {})
    }
  }

  /**
   * First catalog entry for a bare model id under any provider, trying the
   * id as given, then without a "vendor/" prefix, then with the prefix as
   * the provider ("anthropic/claude-x" → provider anthropic, model claude-x).
   */
  lookupAcross(modelId: string): CatalogEntry | undefined {
    const slash = modelId.indexOf("/")
    if (slash > 0) {
      const direct = this.lookup(modelId.slice(0, slash), modelId.slice(slash + 1))
      if (direct) return direct
    }
    const bare = slash > 0 ? modelId.slice(modelId.lastIndexOf("/") + 1) : modelId
    for (const providerId of Object.keys(this.data)) {
      if (GATEWAY_PROVIDERS.has(providerId)) continue
      const entry = this.lookup(providerId, modelId) ?? this.lookup(providerId, bare)
      if (entry) return entry
    }
    return undefined
  }

  static empty(): ModelsCatalog {
    return new ModelsCatalog({})
  }

  /** All known models for a provider, from the cached snapshot. */
  listModels(providerId: string): { id: string; context: number; toolCall?: boolean }[] {
    const provider = this.data[providerId] as
      | { models?: Record<string, Record<string, unknown>> }
      | undefined
    const ids = new Set([
      ...Object.keys(provider?.models ?? {}),
      ...Object.keys(BUILTIN_MODELS[providerId] ?? {}),
    ])
    const models: { id: string; context: number; toolCall?: boolean }[] = []
    for (const id of ids) {
      const entry = this.lookup(providerId, id)
      if (entry) models.push({ id, context: entry.context, toolCall: entry.toolCall })
    }
    return models.sort((a, b) => a.id.localeCompare(b.id))
  }

  /**
   * A cheap same-provider model for summarization work (compaction, the memory
   * evolver) when no small_model is configured. Candidates must:
   * - share the provider, and for gateways the vendor prefix (a user's code is
   *   never routed to a different vendor);
   * - be tool-capable (or unknown), >= 32k context, not deprecated;
   * - cost at most a third of the main model on input and output;
   * - be released within ~18 months of the main model when dates are known.
   * The most recent wins, then the pricier. Undefined when nothing qualifies.
   * Not used for subagents.
   */
  cheapCompanion(providerId: string, modelId: string): string | undefined {
    const main = this.lookup(providerId, modelId)
    const mainIn = main?.cost?.input
    const mainOut = main?.cost?.output
    if (mainIn === undefined || mainIn <= 0) return undefined
    const provider = this.data[providerId] as
      | { models?: Record<string, Record<string, unknown>> }
      | undefined
    const raw = provider?.models ?? {}
    const vendor = (id: string) => (id.includes("/") ? id.slice(0, id.indexOf("/")) : "")
    const released = (id: string): number | undefined => {
      const date = raw[id]?.["release_date"]
      const time = typeof date === "string" ? Date.parse(date) : Number.NaN
      return Number.isNaN(time) ? undefined : time
    }
    const mainReleased = released(modelId)
    const EIGHTEEN_MONTHS = 548 * 24 * 60 * 60 * 1000
    const candidates: { id: string; released: number; price: number }[] = []
    for (const id of Object.keys(raw)) {
      if (id === modelId || vendor(id) !== vendor(modelId)) continue
      if (raw[id]?.["status"] === "deprecated") continue
      const entry = this.lookup(providerId, id)
      const input = entry?.cost?.input
      const output = entry?.cost?.output
      if (!entry || entry.toolCall === false || entry.context < 32_000) continue
      if (input === undefined || input <= 0 || input > mainIn / 3) continue
      if (mainOut !== undefined && output !== undefined && output > mainOut / 3) continue
      const when = released(id)
      if (
        mainReleased !== undefined &&
        when !== undefined &&
        mainReleased - when > EIGHTEEN_MONTHS
      ) {
        continue
      }
      candidates.push({ id, released: when ?? 0, price: input })
    }
    candidates.sort((a, b) => b.released - a.released || b.price - a.price)
    return candidates[0]?.id
  }

  lookup(providerId: string, modelId: string): CatalogEntry | undefined {
    const provider = this.data[providerId] as
      | { models?: Record<string, Record<string, unknown>> }
      | undefined
    const model = provider?.models?.[modelId]
    if (!model) {
      const builtin = BUILTIN_MODELS[providerId]?.[modelId]
      if (builtin) return builtin
      // Gateways (LiteLLM) front other vendors' models under the same ids —
      // "gpt-4o", "anthropic/claude-sonnet-4-6". Resolve the underlying model
      // so limits, pricing and image support still work through the proxy.
      return GATEWAY_PROVIDERS.has(providerId) ? this.lookupAcross(modelId) : undefined
    }
    const limit = model["limit"] as { context?: number; output?: number } | undefined
    if (typeof limit?.context !== "number") return undefined
    const cost = model["cost"] as
      | { input?: number; output?: number; cache_read?: number; cache_write?: number }
      | undefined
    const modalities = model["modalities"] as { input?: unknown } | undefined
    const inputModalities = Array.isArray(modalities?.input) ? modalities.input : undefined
    return {
      context: limit.context,
      output: limit.output,
      toolCall:
        typeof model["tool_call"] === "boolean" ? (model["tool_call"] as boolean) : undefined,
      imageInput: inputModalities ? inputModalities.includes("image") : undefined,
      cost: cost
        ? {
            input: cost.input,
            output: cost.output,
            cacheRead: cost.cache_read,
            cacheWrite: cost.cache_write,
          }
        : undefined,
    }
  }
}
