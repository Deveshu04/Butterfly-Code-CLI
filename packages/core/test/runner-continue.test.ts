import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { latestTurnFacts } from "../src/memory/evolve"
import { SessionJournal } from "../src/session/journal"
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_LENGTH_CONTINUATIONS,
  type RunnerDeps,
  type RunnerEvent,
  runUserTurn,
} from "../src/session/runner"
import { ToolRegistry } from "../src/tool/registry"
import { todoTool } from "../src/tool/tools/todo"
import { MockProvider, zeroUsage } from "./helpers/mock-provider"

function makeDeps(provider: MockProvider, overrides: Partial<RunnerDeps> = {}) {
  const registry = new ToolRegistry()
  registry.register(todoTool)
  const notices: string[] = []
  const deps: RunnerDeps = {
    provider,
    registry,
    journal: SessionJournal.create(mkdtempSync(join(tmpdir(), "bfly-continue-"))),
    rules: { "*": "allow" },
    model: "m",
    system: "sys",
    cwd: "/w",
    state: {},
    onEvent: (event: RunnerEvent) => {
      if (event.type === "notice") notices.push(event.text)
    },
    ...overrides,
  }
  return { deps, notices }
}

const todos = (statuses: ("pending" | "in_progress" | "completed")[]) => ({
  items: statuses.map((status, i) => ({ text: `step ${i + 1}`, status })),
})

const callTodo = (id: string, statuses: ("pending" | "in_progress" | "completed")[]) => [
  { type: "tool-call" as const, callId: id, name: "todo", input: todos(statuses) },
  { type: "finish" as const, reason: "tool-calls" as const, usage: zeroUsage },
]
const say = (text: string, reason: "stop" | "length" = "stop") => [
  { type: "text-delta" as const, text },
  { type: "finish" as const, reason, usage: zeroUsage },
]

test("a model that stops with open todos it set this turn is nudged to continue", async () => {
  const provider = new MockProvider([
    callTodo("t1", ["in_progress", "pending"]),
    say("I'll stop here."),
    callTodo("t2", ["completed", "completed"]),
    say("All done."),
  ])
  const { deps, notices } = makeDeps(provider)
  const outcome = await runUserTurn(deps, "do the two steps")
  expect(outcome.text).toBe("All done.")
  expect(notices.some((n) => n.includes("2 todo(s) still open — continuing (1/2)"))).toBe(true)

  const { events } = SessionJournal.replay(deps.journal.path)
  const nudges = events.filter((e) => e.type === "message.user" && e.synthetic === true)
  expect(nudges.length).toBe(1)
  expect(nudges[0]?.type === "message.user" ? nudges[0].text : "").toContain("[~] step 1")
  // The nudge reaches the model as a user message on the next step.
  const lastRequest = provider.requests[2]
  expect(JSON.stringify(lastRequest?.messages)).toContain("unfinished item")
  // Exactly one turn.completed, and the person's message stays the turn boundary.
  expect(events.filter((e) => e.type === "turn.completed").length).toBe(1)
  expect(latestTurnFacts(events).userText).toBe("do the two steps")
})

test("no progress since the last nudge → no second nudge", async () => {
  const provider = new MockProvider([
    callTodo("t1", ["in_progress"]),
    say("stopping"),
    say("still stopping — I need your input"),
  ])
  const { deps, notices } = makeDeps(provider)
  const outcome = await runUserTurn(deps, "work")
  expect(outcome.text).toBe("still stopping — I need your input")
  expect(notices.filter((n) => n.includes("continuing")).length).toBe(1)
  expect(provider.requests.length).toBe(3)
})

test("nudges are capped by autoContinue, and 0 disables them", async () => {
  const capped = new MockProvider([
    callTodo("t1", ["pending", "pending", "pending"]),
    say("a"),
    callTodo("t2", ["completed", "pending", "pending"]),
    say("b"),
    callTodo("t3", ["completed", "completed", "pending"]),
    say("c"),
  ])
  const first = makeDeps(capped, { autoContinue: 2 })
  await runUserTurn(first.deps, "go")
  expect(first.notices.filter((n) => n.includes("continuing")).length).toBe(2)
  expect(capped.requests.length).toBe(6)

  const off = new MockProvider([callTodo("t1", ["pending"]), say("done?")])
  const second = makeDeps(off, { autoContinue: 0 })
  await runUserTurn(second.deps, "go")
  expect(off.requests.length).toBe(2)
})

test("stale todos from an earlier turn never trigger a nudge", async () => {
  const provider = new MockProvider([say("Paris.")])
  const { deps } = makeDeps(provider, {
    state: { todos: todos(["pending", "pending"]).items },
  })
  const outcome = await runUserTurn(deps, "what is the capital of France?")
  expect(outcome.text).toBe("Paris.")
  expect(provider.requests.length).toBe(1)
})

test("a cut-off reply keeps resuming until it finishes, even after a todo nudge", async () => {
  const provider = new MockProvider([
    callTodo("t1", ["in_progress", "pending"]),
    say("stopping early"),
    say("Step 1 is", "length"),
    say(" done; step 2 needs", "length"),
    say(" one more change", "length"),
    callTodo("t2", ["completed", "completed"]),
    say("All done."),
  ])
  const { deps, notices } = makeDeps(provider, { autoContinue: 1 })
  const outcome = await runUserTurn(deps, "work")
  expect(outcome.text).toBe("All done.")
  expect(provider.requests.length).toBe(7)
  expect(notices.filter((n) => n.includes("output limit — continuing")).length).toBe(3)
  expect(JSON.stringify(provider.requests[3]?.messages)).toContain(
    "cut off by the output-token limit",
  )
})

test("cut-off continuations are capped and progress-gated, then the stop is announced", async () => {
  const many = new MockProvider(Array.from({ length: 8 }, () => say("more", "length")))
  const capped = makeDeps(many)
  await runUserTurn(capped.deps, "explain")
  expect(many.requests.length).toBe(1 + MAX_LENGTH_CONTINUATIONS)
  expect(capped.notices.at(-1)).toContain("type 'continue' to resume")

  const empty = new MockProvider([say("The answer is", "length"), say("", "length")])
  const gated = makeDeps(empty)
  await runUserTurn(gated.deps, "explain")
  expect(empty.requests.length).toBe(2)
  expect(gated.notices.at(-1)).toContain("cut off by the output-token limit")
})

test("a turn that ends with open todos says so instead of ending silently", async () => {
  const provider = new MockProvider([callTodo("t1", ["in_progress"]), say("I need your input")])
  const { deps, notices } = makeDeps(provider, { autoContinue: 0 })
  await runUserTurn(deps, "work")
  expect(notices.at(-1)).toBe("turn ended with 1 todo(s) still open — type 'continue' to resume")
})

test("every step sends an explicit output cap, clamped to what the window has left", async () => {
  const fallback = new MockProvider([say("hi")])
  await runUserTurn(makeDeps(fallback).deps, "x")
  expect(fallback.requests[0]?.maxOutputTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS)

  const usage = { ...zeroUsage, input: 120_000 }
  const clamped = new MockProvider([
    [
      { type: "tool-call" as const, callId: "t1", name: "todo", input: todos(["completed"]) },
      { type: "finish" as const, reason: "tool-calls" as const, usage },
    ],
    [
      { type: "text-delta" as const, text: "ok" },
      { type: "finish" as const, reason: "stop" as const, usage },
    ],
  ])
  await runUserTurn(makeDeps(clamped, { limits: { context: 128_000, output: 16_384 } }).deps, "x")
  expect(clamped.requests[0]?.maxOutputTokens).toBe(16_384)
  expect(clamped.requests[1]?.maxOutputTokens).toBe(128_000 - 120_000 - 4_096)

  const explicit = new MockProvider([say("hi")])
  await runUserTurn(makeDeps(explicit, { maxOutputTokens: 4_000 }).deps, "x")
  expect(explicit.requests[0]?.maxOutputTokens).toBe(4_000)
})

test("an interrupted turn is never auto-continued", async () => {
  const controller = new AbortController()
  const provider = new MockProvider([callTodo("t1", ["pending"]), say("x")])
  const { deps } = makeDeps(provider, {
    signal: controller.signal,
    onEvent: (event) => {
      if (event.type === "tool-result") controller.abort()
    },
  })
  await runUserTurn(deps, "go")
  expect(provider.requests.length).toBeLessThanOrEqual(2)
  const { events } = SessionJournal.replay(deps.journal.path)
  expect(events.some((e) => e.type === "message.user" && e.synthetic === true)).toBe(false)
})
