import { expect, test } from "bun:test"
import type { LoopEvent, LoopOutcome } from "@butterfly/core"
import { applyLoopEvent, INITIAL_LOOP_CARD, loopCardText, loopSummaryText } from "../src/loop-card"


const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

test("applyLoopEvent folds task.claimed into iteration/counts/current task", () => {
  const started: LoopEvent = { type: "loop.started", model: "mock/model" }
  const claimed: LoopEvent = {
    type: "task.claimed",
    id: "bt-1",
    title: "define schema",
    progress: {
      counts: { open: 1, claimed: 1, closed: 0, blocked: 0 },
      usage: zeroUsage,
      iterations: 1,
    },
  }
  const s1 = applyLoopEvent(INITIAL_LOOP_CARD, started)
  const s2 = applyLoopEvent(s1, claimed)
  expect(s2.model).toBe("mock/model")
  expect(s2.currentTask).toBe("define schema")
  expect(s2.iteration).toBe(1)
  expect(s2.counts).toEqual({ open: 1, claimed: 1, closed: 0, blocked: 0 })
})

test("applyLoopEvent records the latest gate result", () => {
  const event: LoopEvent = { type: "gate.result", task: "bt-1", gate: "test", exitCode: 1 }
  const state = applyLoopEvent(INITIAL_LOOP_CARD, event)
  expect(state.lastGate).toEqual({ name: "test", exitCode: 1 })
})

test("applyLoopEvent folds task.closed usage/counts and loopCardText renders it", () => {
  const event: LoopEvent = {
    type: "task.closed",
    id: "bt-1",
    title: "define schema",
    committed: true,
    progress: {
      counts: { open: 1, claimed: 0, closed: 1, blocked: 0 },
      usage: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0 },
      iterations: 1,
    },
  }
  const state = applyLoopEvent({ ...INITIAL_LOOP_CARD, currentTask: "define schema" }, event)
  expect(state.counts.closed).toBe(1)
  const text = loopCardText(state)
  expect(text).toContain("iteration 1")
  expect(text).toContain("done 1")
  expect(text).toContain("1,500 tok")
})

test("applyLoopEvent records the stop reason on loop.stopped", () => {
  const event: LoopEvent = {
    type: "loop.stopped",
    reason: "drained",
    progress: {
      counts: { open: 0, claimed: 0, closed: 2, blocked: 0 },
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      iterations: 2,
    },
  }
  const state = applyLoopEvent(INITIAL_LOOP_CARD, event)
  expect(state.stopReason).toBe("drained")
  expect(state.counts.closed).toBe(2)
})

test("loopCardText starts empty-but-sane before any task has been claimed", () => {
  const text = loopCardText(INITIAL_LOOP_CARD)
  expect(text).toContain("iteration 0")
  expect(text).toContain("ready 0")
  expect(text).not.toContain("tok") // no tokens spent yet
})

test("loopSummaryText matches the CLI's stopped-summary wording", () => {
  const outcome: LoopOutcome = {
    stopReason: "drained",
    iterations: 2,
    closed: 2,
    blocked: 0,
    usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 },
  }
  const text = loopSummaryText(outcome)
  expect(text).toContain("drained")
  expect(text).toContain("2 closed")
  expect(text).toContain("0 blocked")
  expect(text).toContain("2 iteration")
  expect(text).toContain("1,200 tokens")
})
