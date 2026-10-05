import { expect, test } from "bun:test"
import pkg from "../package.json"
import { VERSION } from "../src/version"

/**
 * `VERSION` keys the compiled-exe asset cache (`~/.cache/butterfly/assets/<version>/`).
 * If it drifted from package.json, a release would reuse stale extracted assets.
 * It is derived from package.json; this test guards against re-hardcoding it.
 */
test("VERSION is the package's real version (asset-cache key must never go stale)", () => {
  expect(VERSION).toBe(pkg.version)
})

test("VERSION looks like a semver release", () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+/)
})
