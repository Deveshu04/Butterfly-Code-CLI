import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createModelResolver, parseModelRef } from "../src/provider/hub"
import { ModelsCatalog } from "../src/provider/models-catalog"

// --- parseModelRef ---

test("splits provider from model at the first slash only", () => {
  expect(parseModelRef("openrouter/deepseek/deepseek-chat-v3")).toEqual({
    providerId: "openrouter",
    modelId: "deepseek/deepseek-chat-v3",
  })
  expect(parseModelRef("anthropic/claude-sonnet-4-6")).toEqual({
    providerId: "anthropic",
    modelId: "claude-sonnet-4-6",
  })
})

test("rejects refs without a provider prefix", () => {
  expect(() => parseModelRef("just-a-model")).toThrow(/provider/i)
})

// --- createModelResolver ---

test("resolves preset providers without explicit config", () => {
  const resolve = createModelResolver({}, { OPENROUTER_API_KEY: "sk-test" })
  const resolved = resolve("openrouter/qwen/qwen3-coder")
  expect(resolved.providerId).toBe("openrouter")
  expect(resolved.model).toBeTruthy()
})

test("resolves local providers with no API key at all", () => {
  const resolved = createModelResolver({}, {})("ollama/qwen3:4b")
  expect(resolved.providerId).toBe("ollama")
  expect(resolved.model).toBeTruthy()
})

test("unknown providers need a configured baseURL", () => {
  expect(() => createModelResolver({}, {})("mystery/model-x")).toThrow(/baseURL/i)
  const withConfig = createModelResolver(
    { providers: { mystery: { baseURL: "http://localhost:9999/v1" } } },
    {},
  )
  expect(withConfig("mystery/model-x").model).toBeTruthy()
})

// --- ModelsCatalog ---

const FIXTURE = {
  openrouter: {
    id: "openrouter",
    models: {
      "qwen/qwen3-coder": {
        id: "qwen/qwen3-coder",
        tool_call: true,
        limit: { context: 262_144, output: 65_536 },
        cost: { input: 0.2, output: 0.8, cache_read: 0.05 },
      },
    },
  },
}

function fetchStub(payload: unknown, calls: string[] = []): typeof fetch {
  return (async (url: unknown) => {
    calls.push(String(url))
    return new Response(JSON.stringify(payload), { status: 200 })
  }) as typeof fetch
}

test("catalog fetches, caches to disk, and maps entries", async () => {
  const cachePath = join(mkdtempSync(join(tmpdir(), "bfly-catalog-")), "models.json")
  const catalog = await ModelsCatalog.load({ cachePath, fetchFn: fetchStub(FIXTURE) })
  const entry = catalog.lookup("openrouter", "qwen/qwen3-coder")
  expect(entry).toEqual({
    context: 262_144,
    output: 65_536,
    toolCall: true,
    cost: { input: 0.2, output: 0.8, cacheRead: 0.05, cacheWrite: undefined },
  })
  expect(readFileSync(cachePath, "utf8")).toContain("qwen3-coder")
})

test("fresh cache is served without refetching", async () => {
  const cachePath = join(mkdtempSync(join(tmpdir(), "bfly-catalog-")), "models.json")
  const calls: string[] = []
  await ModelsCatalog.load({ cachePath, fetchFn: fetchStub(FIXTURE, calls) })
  await ModelsCatalog.load({ cachePath, fetchFn: fetchStub(FIXTURE, calls) })
  expect(calls.length).toBe(1)
})

test("a failing refresh falls back to the stale cache", async () => {
  const cachePath = join(mkdtempSync(join(tmpdir(), "bfly-catalog-")), "models.json")
  writeFileSync(cachePath, JSON.stringify({ fetchedAt: 0, data: FIXTURE }))
  const failing = (async () => {
    throw new Error("offline")
  }) as unknown as typeof fetch
  const catalog = await ModelsCatalog.load({ cachePath, fetchFn: failing })
  expect(catalog.lookup("openrouter", "qwen/qwen3-coder")?.context).toBe(262_144)
})

test("listModels returns ids with context for a provider", async () => {
  const cachePath = join(mkdtempSync(join(tmpdir(), "bfly-catalog-")), "models.json")
  const catalog = await ModelsCatalog.load({ cachePath, fetchFn: fetchStub(FIXTURE) })
  const models = catalog.listModels("openrouter")
  expect(models).toEqual([{ id: "qwen/qwen3-coder", context: 262_144, toolCall: true }])
  expect(catalog.listModels("nope")).toEqual([])
})

test("unknown models return undefined", async () => {
  const cachePath = join(mkdtempSync(join(tmpdir(), "bfly-catalog-")), "models.json")
  const catalog = await ModelsCatalog.load({ cachePath, fetchFn: fetchStub(FIXTURE) })
  expect(catalog.lookup("openrouter", "nope")).toBeUndefined()
  expect(ModelsCatalog.empty().lookup("x", "y")).toBeUndefined()
})
