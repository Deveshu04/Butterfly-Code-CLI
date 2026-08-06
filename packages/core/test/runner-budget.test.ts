import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { assemble } from "../src/session/assembly"
import type { SessionEvent } from "../src/session/events"
import { SessionJournal } from "../src/session/journal"
import { project } from "../src/session/projector"
import { type RunnerDeps, type RunnerEvent, runUserTurn } from "../src/session/runner"
import { ToolRegistry } from "../src/tool/registry"
import { MockProvider } from "./helpers/mock-provider"

function makeDeps(provider: MockProvider, overrides: Partial<RunnerDeps> = {}): RunnerDeps {
  const registry = new ToolRegistry()
  registry.register({
    name: "echo",
    description: "Echoes text.",
    inputSchema: z.object({ text: z.string() }),
    execute: async (input) => ({ output: `echo: ${input.text}` }),
  })
  return {
    provider,
    registry,
    journal: SessionJournal.create(mkdtempSync(join(tmpdir(), "bfly-budget-"))),
    rules: { "*": "allow" },
    model: "mock-model",
    system: "s",
    cwd: "/w",
    ...overrides,
  }
}

const bigUsage = { input: 60_000, output: 1_000, cacheRead: 0, cacheWrite: 0 }

test("budget ceiling stops the loop between steps", async () => {
  const step = (n: number) => [
    { type: "tool-call" as const, callId: `c${n}`, name: "echo", input: { text: "go" } },
    { type: "finish" as const, reason: "tool-calls" as const, usage: bigUsage },
  ]
  const provider = new MockProvider([step(1), step(2), step(3)])
  const deps = makeDeps(provider, { budgetTokens: 100_000 })
  const outcome = await runUserTurn(deps, "spend a lot")

  // First step: 61k spent (under). Second step: 122k (over) — stop before a third.
  expect(outcome.steps).toBe(2)
  expect(outcome.budgetExceeded).toBe(true)
  expect(provider.requests.length).toBe(2)
})

test("a third identical tool call is intercepted, not executed", async () => {
  const call = { type: "tool-call" as const, callId: "", name: "echo", input: { text: "same" } }
  const step = (n: number) => [
    { ...call, callId: `c${n}` },
    { type: "finish" as const, reason: "tool-calls" as const, usage: bigUsage },
  ]
  const provider = new MockProvider([
    step(1),
    step(2),
    step(3),
    [
      { type: "text-delta", text: "giving up" },
      { type: "finish", reason: "stop", usage: bigUsage },
    ],
  ])

  let executions = 0
  const registry = new ToolRegistry()
  registry.register({
    name: "echo",
    description: "Echoes text.",
    inputSchema: z.object({ text: z.string() }),
    execute: async (input) => {
      executions += 1
      return { output: `echo: ${input.text}` }
    },
  })
  const deps = makeDeps(provider, { registry })
  await runUserTurn(deps, "repeat forever")

  expect(executions).toBe(2)
  const { events } = SessionJournal.replay(deps.journal.path)
  const results = events.filter((e) => e.type === "tool.result")
  const third = results[2]
  expect(third && "isError" in third ? third.isError : false).toBe(true)
  expect(third && "output" in third ? third.output : "").toContain("identical")
})

test("stale large tool outputs are pruned between steps", async () => {
  const provider = new MockProvider([
    [
      { type: "tool-call", callId: "c1", name: "echo", input: { text: "big" } },
      { type: "finish", reason: "tool-calls", usage: bigUsage },
    ],
    [
      { type: "tool-call", callId: "c2", name: "echo", input: { text: "later" } },
      { type: "finish", reason: "tool-calls", usage: bigUsage },
    ],
    [
      { type: "text-delta", text: "done" },
      { type: "finish", reason: "stop", usage: bigUsage },
    ],
  ])
  const registry = new ToolRegistry()
  registry.register({
    name: "echo",
    description: "Echoes a lot.",
    inputSchema: z.object({ text: z.string() }),
    execute: async (input) => ({ output: input.text.repeat(3_000) }),
  })
  const deps = makeDeps(provider, { registry, pruneWindowTokens: 500 })
  await runUserTurn(deps, "generate noise")

  const { events } = SessionJournal.replay(deps.journal.path)
  const pruned = events.find((e) => e.type === "tool.pruned")
  expect(pruned && "callIds" in pruned ? pruned.callIds : []).toContain("c1")
})

test("compaction fires when a step approaches the context limit", async () => {
  const nearLimit = { input: 90_000, output: 2_000, cacheRead: 0, cacheWrite: 0 }
  const provider = new MockProvider([
    // Step 1: tool call whose usage crosses the compaction threshold.
    [
      { type: "tool-call", callId: "c1", name: "echo", input: { text: "work" } },
      { type: "finish", reason: "tool-calls", usage: nearLimit },
    ],
    // Summarizer call (compactSession reuses the provider).
    [
      { type: "text-delta", text: "## Objective\n- summarized" },
      { type: "finish", reason: "stop", usage: bigUsage },
    ],
    // Step 2 continues after compaction.
    [
      { type: "text-delta", text: "done" },
      { type: "finish", reason: "stop", usage: bigUsage },
    ],
  ])
  const deps = makeDeps(provider, {
    limits: { context: 100_000, output: 16_000 },
    compactKeepTokens: 200,
  })
  const outcome = await runUserTurn(deps, `context filler ${"x".repeat(8_000)}`)

  expect(outcome.text).toBe("done")
  const { events } = SessionJournal.replay(deps.journal.path)
  expect(events.some((e) => e.type === "session.compacted")).toBe(true)
})

test("dollar budget stops the loop and emits warnings", async () => {
  const step = (n: number) => [
    { type: "tool-call" as const, callId: `c${n}`, name: "echo", input: { text: "go" } },
    { type: "finish" as const, reason: "tool-calls" as const, usage: bigUsage },
  ]
  const provider = new MockProvider([step(1), step(2), step(3)])
  const notices: string[] = []
  const deps = makeDeps(provider, {
    cost: { input: 10, output: 30 },
    maxSpendUSD: 1.0,
    onEvent: (event) => {
      if (event.type === "notice") notices.push(event.text)
    },
  })
  const outcome = await runUserTurn(deps, "spend dollars")

  expect(outcome.steps).toBe(2)
  expect(outcome.budgetExceeded).toBe(true)
  expect(outcome.costUSD).toBeCloseTo(1.26, 2)
  expect(notices.some((n) => n.includes("budget"))).toBe(true)
})

test("cost accumulates in the outcome when pricing is known", async () => {
  const provider = new MockProvider([
    [
      { type: "text-delta", text: "ok" },
      { type: "finish", reason: "stop", usage: bigUsage },
    ],
  ])
  const deps = makeDeps(provider, { cost: { input: 10, output: 30 } })
  const outcome = await runUserTurn(deps, "one step")
  expect(outcome.costUSD).toBeCloseTo(0.63, 2)
})

test("reasoning effort is forwarded to the provider request", async () => {
  const provider = new MockProvider([
    [
      { type: "text-delta", text: "ok" },
      { type: "finish", reason: "stop", usage: bigUsage },
    ],
  ])
  const deps = makeDeps(provider, { reasoning: "high" })
  await runUserTurn(deps, "think hard")
  expect(provider.requests[0]?.reasoning).toBe("high")
})

test("onEvent streams deltas, tool calls, and tool results", async () => {
  const provider = new MockProvider([
    [
      { type: "tool-call", callId: "c1", name: "echo", input: { text: "hi" } },
      { type: "finish", reason: "tool-calls", usage: bigUsage },
    ],
    [
      { type: "text-delta", text: "done" },
      { type: "finish", reason: "stop", usage: bigUsage },
    ],
  ])
  const seen: string[] = []
  const deps = makeDeps(provider, { onEvent: (event: RunnerEvent) => seen.push(event.type) })
  await runUserTurn(deps, "stream me")

  expect(seen).toContain("tool-call")
  expect(seen).toContain("tool-result")
  expect(seen).toContain("text-delta")
})

function assertPaired(events: SessionEvent[]): void {
  const calls = events
    .filter((e) => e.type === "tool.call")
    .map((e) => (e as { callId: string }).callId)
  const results = events
    .filter((e) => e.type === "tool.result")
    .map((e) => (e as { callId: string }).callId)
  expect(results).toEqual(calls)
}

test("a TOKEN budget stop mid-batch still journals a result for every pending call", async () => {
  const provider = new MockProvider([
    [
      { type: "tool-call", callId: "c1", name: "echo", input: { text: "one" } },
      { type: "finish", reason: "tool-calls", usage: bigUsage },
    ],
    [
      { type: "tool-call", callId: "c2", name: "echo", input: { text: "two" } },
      { type: "tool-call", callId: "c3", name: "echo", input: { text: "three" } },
      { type: "finish", reason: "tool-calls", usage: bigUsage },
    ],
  ])
  const deps = makeDeps(provider, { budgetTokens: 100_000 })
  const outcome = await runUserTurn(deps, "spend a lot")
  expect(outcome.budgetExceeded).toBe(true)

  const { events } = SessionJournal.replay(deps.journal.path)
  assertPaired(events)
  const abandoned = events.filter(
    (e) => e.type === "tool.result" && e.isError && e.output.includes("budget stop"),
  )
  expect(abandoned.length).toBe(2)

  // The invariant that actually matters: the very next turn must assemble
  // into something a provider will accept — every assistant toolCall id
  // answered by a tool message.
  const messages = assemble({
    system: "s",
    timeline: project(SessionJournal.replay(deps.journal.path).header, events).timeline,
  })
  const called = new Set<string>()
  const answered = new Set<string>()
  for (const message of messages) {
    if (message.role === "assistant")
      for (const call of message.toolCalls ?? []) called.add(call.callId)
    if (message.role === "tool") answered.add(message.callId)
  }
  expect(called.size).toBeGreaterThan(0)
  expect([...called].every((id) => answered.has(id))).toBe(true)
})

test("a DOLLAR budget stop mid-batch pairs its pending calls too", async () => {
  const provider = new MockProvider([
    [
      { type: "tool-call", callId: "c1", name: "echo", input: { text: "one" } },
      { type: "finish", reason: "tool-calls", usage: bigUsage },
    ],
    [
      { type: "tool-call", callId: "c2", name: "echo", input: { text: "two" } },
      { type: "finish", reason: "tool-calls", usage: bigUsage },
    ],
  ])
  const seen: RunnerEvent[] = []
  const deps = makeDeps(provider, {
    cost: { input: 10, output: 30 },
    maxSpendUSD: 1.0,
    onEvent: (event) => seen.push(event),
  })
  const outcome = await runUserTurn(deps, "spend dollars")
  expect(outcome.budgetExceeded).toBe(true)

  const { events } = SessionJournal.replay(deps.journal.path)
  assertPaired(events)
  // The UI hears about the abandoned call too — no tool row left spinning.
  expect(
    seen.some((e) => e.type === "tool-result" && e.callId === "c2" && e.isError === true),
  ).toBe(true)
})

test("tool calls emitted with a non-tool-calls finish reason are still answered", async () => {
  const provider = new MockProvider([
    [
      { type: "tool-call", callId: "c1", name: "echo", input: { text: "orphan" } },
      { type: "finish", reason: "stop", usage: bigUsage },
    ],
  ])
  const deps = makeDeps(provider)
  await runUserTurn(deps, "confuse the loop")
  const { events } = SessionJournal.replay(deps.journal.path)
  assertPaired(events)
})
