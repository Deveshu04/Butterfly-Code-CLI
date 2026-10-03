import { expect, test } from "bun:test"
import { computeCostUSD } from "../src/provider/pricing"

const cost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }

test("uncached usage bills input and output at their rates", () => {
  expect(
    computeCostUSD({ input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0 }, cost),
  ).toBeCloseTo(3 + 1.5, 10)
})

test("cached tokens are part of input and bill ONLY at the cache rates (no double count)", () => {
  // 1M-token prompt: 900k read from cache, 50k written to it, 50k fresh.
  const usage = { input: 1_000_000, output: 0, cacheRead: 900_000, cacheWrite: 50_000 }
  expect(computeCostUSD(usage, cost)).toBeCloseTo(0.05 * 3 + 0.9 * 0.3 + 0.05 * 3.75, 10)
})

test("inconsistent provider numbers never bill negative fresh input", () => {
  expect(computeCostUSD({ input: 10, output: 0, cacheRead: 50, cacheWrite: 0 }, cost)).toBeCloseTo(
    (50 * 0.3) / 1_000_000,
    12,
  )
})

test("cache hit rate is the cached share of prompt tokens", async () => {
  const { cacheHitRate } = await import("../src/provider/pricing")
  expect(cacheHitRate({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeUndefined()
  expect(cacheHitRate({ input: 1_000, output: 10, cacheRead: 900, cacheWrite: 0 })).toBe(0.9)
})
