import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export interface CatalogEntry {
  context: number
  output?: number
  toolCall?: boolean
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
  cacheOnly?: boolean
}

export type CatalogCacheStatus = "fresh" | "stale" | "missing"

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
  }
  return undefined
}

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

  static empty(): ModelsCatalog {
    return new ModelsCatalog({})
  }

  listModels(providerId: string): { id: string; context: number; toolCall?: boolean }[] {
    const provider = this.data[providerId] as
      | { models?: Record<string, Record<string, unknown>> }
      | undefined
    if (!provider?.models) return []
    const models: { id: string; context: number; toolCall?: boolean }[] = []
    for (const id of Object.keys(provider.models)) {
      const entry = this.lookup(providerId, id)
      if (entry) models.push({ id, context: entry.context, toolCall: entry.toolCall })
    }
    return models.sort((a, b) => a.id.localeCompare(b.id))
  }

  lookup(providerId: string, modelId: string): CatalogEntry | undefined {
    const provider = this.data[providerId] as
      | { models?: Record<string, Record<string, unknown>> }
      | undefined
    const model = provider?.models?.[modelId]
    if (!model) return undefined
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
