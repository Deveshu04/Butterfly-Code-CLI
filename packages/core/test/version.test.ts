import { expect, test } from "bun:test"
import pkg from "../package.json"
import { VERSION } from "../src/version"

test("VERSION is the package's real version (asset-cache key must never go stale)", () => {
  expect(VERSION).toBe(pkg.version)
})

test("VERSION looks like a semver release", () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+/)
})
