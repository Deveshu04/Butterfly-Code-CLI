import { expect, test } from "bun:test"
import type { LoopEvent, LoopProgress } from "@butterfly/core"
import { formatLoopTaskEvent } from "../src/loop"

/** `butterfly loop run` task-outcome lines use plain "ok"/"FAIL" words, never glyphs. */

const progress: LoopProgress = {
  counts: { open: 0, claimed: 0, closed: 1, blocked: 0 },
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  iterations: 1,
}

test("task.closed prints a plain 'ok' line, never a check-mark glyph", () => {
  const event: LoopEvent = {
    type: "task.closed",
    id: "t1",
    title: "add the widget",
    committed: true,
    progress,
  }
  const line = formatLoopTaskEvent(event)
  expect(line).toBe("ok add the widget")
})

test("task.failed prints a plain 'FAIL' line with the attempt count, never a cross glyph", () => {
  const event: LoopEvent = {
    type: "task.failed",
    id: "t1",
    title: "add the widget",
    attempts: 2,
    progress,
  }
  const line = formatLoopTaskEvent(event)
  expect(line).toBe("FAIL add the widget (attempt 2)")
  expect(line).not.toContain("✓")
  expect(line).not.toContain("✗")
})

test("every other LoopEvent variant prints nothing (unchanged CLI behavior)", () => {
  const event: LoopEvent = { type: "loop.started", model: "mock/model" }
  expect(formatLoopTaskEvent(event)).toBeUndefined()
})
