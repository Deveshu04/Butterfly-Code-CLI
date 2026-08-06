import { expect, test } from "bun:test"
import { VERSION } from "@butterfly/core"

test("workspace wiring resolves @butterfly/core", () => {
  // Not pinned to a literal: VERSION is derived from package.json (version.ts),
  // so a release bump must not need a test edit. version.test.ts owns the sync check.
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+/)
})
