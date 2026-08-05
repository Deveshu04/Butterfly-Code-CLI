import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { catalogCacheStatus, ModelsCatalog } from "../src/provider/models-catalog"

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function neverFetch(): typeof fetch {
  return (() => {
    throw new Error("cacheOnly must never call fetch")
  }) as unknown as typeof fetch
}

test("cacheOnly never fetches and never writes when there is no cache yet", async () => {
  const cachePath = join(tempDir("bfly-catalog-"), "models-cache.json")
  const catalog = await ModelsCatalog.load({ cachePath, cacheOnly: true, fetchFn: neverFetch() })
  expect(catalog.listModels("ollama")).toEqual([])
  expect(existsSync(cachePath)).toBe(false)
})

test("cacheOnly returns fresh cached data without touching the network", async () => {
  const dir = tempDir("bfly-catalog-")
  const cachePath = join(dir, "models-cache.json")
  writeFileSync(
    cachePath,
    JSON.stringify({
      fetchedAt: Date.now(),
      data: { ollama: { models: { "qwen3:8b": { limit: { context: 32000 } } } } },
    }),
  )
  const catalog = await ModelsCatalog.load({ cachePath, cacheOnly: true, fetchFn: neverFetch() })
  expect(catalog.lookup("ollama", "qwen3:8b")).toEqual({
    context: 32000,
    output: undefined,
    toolCall: undefined,
    cost: undefined,
  })
})

test("cacheOnly returns stale cached data as-is — no refresh, no write", async () => {
  const dir = tempDir("bfly-catalog-")
  const cachePath = join(dir, "models-cache.json")
  const staleData = { ollama: { models: { "qwen3:8b": { limit: { context: 32000 } } } } }
  writeFileSync(cachePath, JSON.stringify({ fetchedAt: Date.now() - 999_999_999, data: staleData }))
  const catalog = await ModelsCatalog.load({
    cachePath,
    cacheOnly: true,
    maxAgeMs: 1,
    fetchFn: neverFetch(),
  })
  expect(catalog.lookup("ollama", "qwen3:8b")?.context).toBe(32000)
})

test("lookup reports imageInput from the models.dev modalities.input array", () => {
  const dir = tempDir("bfly-catalog-")
  const cachePath = join(dir, "models-cache.json")
  writeFileSync(
    cachePath,
    JSON.stringify({
      fetchedAt: Date.now(),
      data: {
        anthropic: {
          models: {
            "claude-x": { limit: { context: 200000 }, modalities: { input: ["text", "image"] } },
          },
        },
        zhipuai: {
          models: {
            "glm-x": { limit: { context: 200000 }, modalities: { input: ["text"] } },
          },
        },
        legacy: {
          models: { "no-modalities": { limit: { context: 1000 } } },
        },
      },
    }),
  )
  return ModelsCatalog.load({ cachePath, cacheOnly: true, fetchFn: neverFetch() }).then(
    (loaded) => {
      expect(loaded.lookup("anthropic", "claude-x")?.imageInput).toBe(true)
      expect(loaded.lookup("zhipuai", "glm-x")?.imageInput).toBe(false)
      expect(loaded.lookup("legacy", "no-modalities")?.imageInput).toBeUndefined()
    },
  )
})

test("catalogCacheStatus reports missing, fresh, and stale correctly", () => {
  const dir = tempDir("bfly-catalog-status-")
  const cachePath = join(dir, "models-cache.json")
  expect(catalogCacheStatus(cachePath)).toBe("missing")

  writeFileSync(cachePath, JSON.stringify({ fetchedAt: Date.now(), data: {} }))
  expect(catalogCacheStatus(cachePath)).toBe("fresh")

  writeFileSync(cachePath, JSON.stringify({ fetchedAt: Date.now() - 999_999_999, data: {} }))
  expect(catalogCacheStatus(cachePath, 1_000)).toBe("stale")
})

test("catalogCacheStatus treats an unreadable directory the same as missing, never throws", () => {
  const dir = tempDir("bfly-catalog-status-missing-")
  mkdirSync(join(dir, "sub"), { recursive: true })
  expect(catalogCacheStatus(join(dir, "sub", "no-such-file.json"))).toBe("missing")
})
