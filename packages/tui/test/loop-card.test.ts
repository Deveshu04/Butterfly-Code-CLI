import { expect, test } from "bun:test"
import type { LoopEvent, LoopOutcome, PermissionRules } from "@butterfly/core"
import {
  applyLoopEvent,
  askBearingRules,
  askRulesWarning,
  dirtyLoopLines,
  dirtyTreeOverride,
  dirtyTreeRefusal,
  INITIAL_LOOP_CARD,
  loopCardText,
  loopSpendCredit,
  loopSummaryText,
  spendCapNotice,
} from "../src/loop-card"

/** Pure reducer/formatter tests with hand-built LoopEvents; no rendering or real loop. */

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

// --- preflight guards ---

test("dirtyLoopLines keeps real changes and drops .butterfly/ runtime state", () => {
  const porcelain = [
    " M packages/tui/src/app.tsx",
    "?? .butterfly/",
    "?? .butterfly/queue.db",
    "A  docs/new.md",
    "",
  ].join("\n")
  expect(dirtyLoopLines(porcelain)).toEqual([" M packages/tui/src/app.tsx", "A  docs/new.md"])
})

test("dirtyLoopLines reports a repo with only .butterfly/ churn as clean", () => {
  expect(dirtyLoopLines("?? .butterfly/\n")).toEqual([])
  expect(dirtyLoopLines("")).toEqual([])
})

test("dirtyTreeRefusal names the git add -A risk and the explicit opt-out", () => {
  const text = dirtyTreeRefusal([" M src/a.ts", " M src/b.ts"])
  expect(text).toContain("2 uncommitted change")
  expect(text).toContain("git add -A")
  expect(text).toContain("--allow-dirty")
  expect(text).toContain("src/a.ts")
})

test("dirtyTreeOverride is loud about sweeping the changes into loop commits", () => {
  const text = dirtyTreeOverride([" M src/a.ts"])
  expect(text).toContain("--allow-dirty")
  expect(text).toContain("1 uncommitted change")
  expect(text).toContain("WILL be included")
})

test("askBearingRules finds explicit ask entries at both levels", () => {
  const rules: PermissionRules = {
    "*": "allow",
    bash: { "git *": "allow", "rm *": "ask" },
    edit: "ask",
  }
  const found = askBearingRules(rules)
  expect(found).toContain("edit")
  expect(found).toContain("bash: rm *")
  expect(found.length).toBe(2)
})

test("askBearingRules flags the IMPLICIT ask when no root default is set", () => {
  // resolvePermission() falls through to "ask" when rules["*"] is absent.
  const found = askBearingRules({ bash: { "git *": "allow" } })
  expect(found.length).toBe(1)
  expect(found[0]).toContain("*")
})

test("askBearingRules returns nothing for a loop-safe allow tree", () => {
  expect(askBearingRules({ "*": "allow", edit: { ".env*": "deny" } })).toEqual([])
})

test("askRulesWarning explains the unattended failure mode and stays warn-only", () => {
  const text = askRulesWarning(["edit", "bash: rm *"])
  expect(text).toContain("UNATTENDED")
  expect(text).toContain("edit")
  expect(text).toContain("no-progress")
})

test("loopSpendCredit credits only the delta, so cumulative usage never double-counts", () => {
  const cost = { input: 1_000_000, output: 2_000_000 }
  const first = loopSpendCredit({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, cost, 0)
  expect(first.delta).toBeCloseTo(3, 10)
  expect(first.credited).toBeCloseTo(3, 10)
  // Same cumulative snapshot replayed (loop.stopped repeats the totals):
  const repeat = loopSpendCredit(
    { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    cost,
    first.credited,
  )
  expect(repeat.delta).toBe(0)
  expect(repeat.credited).toBeCloseTo(3, 10)
  const grown = loopSpendCredit(
    { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
    cost,
    repeat.credited,
  )
  expect(grown.delta).toBeCloseTo(1, 10)
  expect(grown.credited).toBeCloseTo(4, 10)
})

test("loopSpendCredit is a no-op when the model has no catalog pricing", () => {
  const result = loopSpendCredit(
    { input: 99, output: 99, cacheRead: 0, cacheWrite: 0 },
    undefined,
    0,
  )
  expect(result).toEqual({ credited: 0, delta: 0 })
})

test("spendCapNotice says the per-turn cap is not enforced by the loop", () => {
  const text = spendCapNotice(5)
  expect(text).toContain("$5.00")
  expect(text).toContain("not enforced")
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
