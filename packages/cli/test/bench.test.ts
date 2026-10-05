import { expect, test } from "bun:test"
import type { BenchTaskResult } from "@butterfly/core"
import { formatBenchResultLine } from "../src/bench"

/** Headless bench output uses plain "ok"/"FAIL" words, never glyphs. */

function fakeResult(overrides: Partial<BenchTaskResult>): BenchTaskResult {
  return {
    id: "task-1",
    solved: true,
    metrics: {
      usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
      turns: 1,
      steps: 1,
      toolCalls: 1,
      toolErrors: 0,
      editCalls: 1,
      malformedEdits: 0,
    },
    checkOutput: "",
    fixtureDir: "/tmp/fixture",
    kept: false,
    ...overrides,
  }
}

test("a solved task prints a plain 'ok' line, never a check-mark glyph", () => {
  const line = formatBenchResultLine(fakeResult({ solved: true }))
  expect(line.startsWith("ok task-1")).toBe(true)
  expect(line).not.toContain("✓")
  expect(line).not.toContain("✗")
})

test("an unsolved task prints a plain 'FAIL' line with the check output, never a cross glyph", () => {
  const line = formatBenchResultLine(
    fakeResult({ solved: false, checkOutput: "test failed: expected 2 got 1" }),
  )
  expect(line.startsWith("FAIL task-1")).toBe(true)
  expect(line).toContain("test failed: expected 2 got 1")
  expect(line).not.toContain("✓")
  expect(line).not.toContain("✗")
})
