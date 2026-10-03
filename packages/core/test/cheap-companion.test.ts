import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ModelsCatalog } from "../src/provider/models-catalog"

const model = (input: number, output: number, release: string, extra: object = {}) => ({
  limit: { context: 128_000 },
  tool_call: true,
  cost: { input, output },
  release_date: release,
  ...extra,
})

async function catalog(data: Record<string, unknown>): Promise<ModelsCatalog> {
  const cachePath = join(mkdtempSync(join(tmpdir(), "bfly-companion-")), "models-cache.json")
  writeFileSync(cachePath, JSON.stringify({ fetchedAt: Date.now(), data }))
  return ModelsCatalog.load({ cachePath, cacheOnly: true })
}

test("picks the most recent model priced at most a third of the main one", async () => {
  const c = await catalog({
    vendor: {
      models: {
        big: model(3, 15, "2026-06-01"),
        "mid-new": model(1, 5, "2026-05-01"),
        "mini-old": model(0.2, 0.8, "2025-09-01"),
        "mini-new": model(0.25, 1, "2026-04-01"),
        "too-pricey": model(2, 10, "2026-06-01"),
      },
    },
  })
  expect(c.cheapCompanion("vendor", "big")).toBe("mid-new")
})

test("skips deprecated, tool-less, small-context and ancient models", async () => {
  const c = await catalog({
    vendor: {
      models: {
        big: model(3, 15, "2026-06-01"),
        dep: model(0.5, 2, "2026-05-01", { status: "deprecated" }),
        notools: model(0.5, 2, "2026-05-01", { tool_call: false }),
        tiny: model(0.5, 2, "2026-05-01", { limit: { context: 8_000 } }),
        ancient: model(0.5, 2, "2023-01-01"),
      },
    },
  })
  expect(c.cheapCompanion("vendor", "big")).toBeUndefined()
})

test("gateways stay within the main model's vendor prefix", async () => {
  const c = await catalog({
    openrouter: {
      models: {
        "anthropic/big": model(3, 15, "2026-06-01"),
        "other/very-cheap": model(0.05, 0.1, "2026-06-01"),
        "anthropic/small": model(0.8, 4, "2026-03-01"),
      },
    },
  })
  expect(c.cheapCompanion("openrouter", "anthropic/big")).toBe("anthropic/small")
})

test("unpriced or free main models have no companion", async () => {
  const c = await catalog({
    local: { models: { m: { limit: { context: 32_000 } }, n: model(0.1, 0.1, "2026-01-01") } },
  })
  expect(c.cheapCompanion("local", "m")).toBeUndefined()
  expect(c.cheapCompanion("local", "missing")).toBeUndefined()
})
