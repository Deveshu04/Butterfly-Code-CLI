import { expect, test } from "bun:test"
import { VERSION } from "@butterfly/core"

test("workspace wiring resolves @butterfly/core", () => {
  expect(VERSION).toBe("0.0.1")
})
