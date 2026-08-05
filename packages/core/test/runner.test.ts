import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { SessionJournal } from "../src/session/journal"
import { type RunnerDeps, runUserTurn } from "../src/session/runner"
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
    journal: SessionJournal.create(mkdtempSync(join(tmpdir(), "bfly-run-"))),
    rules: { "*": "allow" },
    model: "mock-model",
    system: "You are Butterfly.",
    cwd: "/w",
    ...overrides,
  }
}

const usage1 = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }
const usage2 = { input: 150, output: 20, cacheRead: 90, cacheWrite: 0 }

test("text-only turn journals assistant text and completes with usage", async () => {
  const provider = new MockProvider([
    [
      { type: "text-delta", text: "hel" },
      { type: "text-delta", text: "lo" },
      { type: "finish", reason: "stop", usage: usage1 },
    ],
  ])
  const deps = makeDeps(provider)
  const outcome = await runUserTurn(deps, "say hello")

  expect(outcome.text).toBe("hello")
  expect(outcome.steps).toBe(1)
  expect(outcome.usage).toEqual(usage1)

  const { events } = SessionJournal.replay(deps.journal.path)
  const types = events.map((e) => e.type)
  expect(types).toEqual(["message.user", "message.assistant", "turn.completed"])
})

test("tool-call step executes the tool and loops until stop", async () => {
  const provider = new MockProvider([
    [
      { type: "tool-call", callId: "c1", name: "echo", input: { text: "ping" } },
      { type: "finish", reason: "tool-calls", usage: usage1 },
    ],
    [
      { type: "text-delta", text: "pong" },
      { type: "finish", reason: "stop", usage: usage2 },
    ],
  ])
  const deps = makeDeps(provider)
  const outcome = await runUserTurn(deps, "ping the tool")

  expect(outcome.text).toBe("pong")
  expect(outcome.steps).toBe(2)
  expect(outcome.usage).toEqual({ input: 250, output: 30, cacheRead: 90, cacheWrite: 0 })

  const { events } = SessionJournal.replay(deps.journal.path)
  expect(events.map((e) => e.type)).toEqual([
    "message.user",
    "message.assistant",
    "tool.call",
    "tool.result",
    "message.assistant",
    "turn.completed",
  ])

  // The second provider call must see the tool result in its request.
  const second = provider.requests[1]
  const toolMessage = second?.messages.find((m) => m.role === "tool")
  expect(toolMessage && "output" in toolMessage ? toolMessage.output : "").toBe("echo: ping")
})

test("denied tools surface as error results and the loop continues", async () => {
  const provider = new MockProvider([
    [
      { type: "tool-call", callId: "c1", name: "echo", input: { text: "blocked" } },
      { type: "finish", reason: "tool-calls", usage: usage1 },
    ],
    [
      { type: "text-delta", text: "understood" },
      { type: "finish", reason: "stop", usage: usage2 },
    ],
  ])
  const deps = makeDeps(provider, { rules: { echo: "deny" } })
  const outcome = await runUserTurn(deps, "try it")

  expect(outcome.text).toBe("understood")
  const { events } = SessionJournal.replay(deps.journal.path)
  const result = events.find((e) => e.type === "tool.result")
  expect(result && "isError" in result ? result.isError : false).toBe(true)
})

test("emits a per-call turn.snapshot with callId before a mutating call, skips non-mutating tools", async () => {
  const provider = new MockProvider([
    [
      { type: "tool-call", callId: "c1", name: "edit", input: { file_path: "a.ts" } },
      { type: "tool-call", callId: "c2", name: "read", input: { file_path: "a.ts" } },
      { type: "finish", reason: "tool-calls", usage: usage1 },
    ],
    [
      { type: "text-delta", text: "done" },
      { type: "finish", reason: "stop", usage: usage2 },
    ],
  ])
  const registry = new ToolRegistry()
  registry.register({
    name: "edit",
    description: "e",
    inputSchema: z.object({ file_path: z.string() }),
    execute: async () => ({ output: "edited" }),
  })
  registry.register({
    name: "read",
    description: "r",
    inputSchema: z.object({ file_path: z.string() }),
    execute: async () => ({ output: "contents" }),
  })
  let snapCalls = 0
  const deps = makeDeps(provider, {
    registry,
    createSnapshot: async () => {
      snapCalls += 1
      return `${"a".repeat(39)}${snapCalls}`
    },
    listUntracked: async () => ["new.txt"],
  })
  await runUserTurn(deps, "edit and read")

  const { events } = SessionJournal.replay(deps.journal.path)
  const snapshots = events.filter((e) => e.type === "turn.snapshot")
  // one turn-start snapshot (no callId) + one for the "edit" call only.
  expect(snapshots.length).toBe(2)
  const turnStart = snapshots[0]
  const perCall = snapshots[1]
  expect(turnStart && "callId" in turnStart ? turnStart.callId : undefined).toBeUndefined()
  if (perCall && perCall.type === "turn.snapshot") {
    expect(perCall.callId).toBe("c1")
    expect(perCall.tool).toBe("edit")
    expect(perCall.argsPreview).toContain("a.ts")
    expect(perCall.untracked).toEqual(["new.txt"])
  } else {
    throw new Error("expected a per-call turn.snapshot event")
  }
  expect(snapshots.some((s) => "callId" in s && s.callId === "c2")).toBe(false)
})

test("bash calls also get a pre-call snapshot", async () => {
  const provider = new MockProvider([
    [
      { type: "tool-call", callId: "c1", name: "bash", input: { command: "echo hi" } },
      { type: "finish", reason: "tool-calls", usage: usage1 },
    ],
    [
      { type: "text-delta", text: "done" },
      { type: "finish", reason: "stop", usage: usage2 },
    ],
  ])
  const registry = new ToolRegistry()
  registry.register({
    name: "bash",
    description: "b",
    inputSchema: z.object({ command: z.string() }),
    execute: async () => ({ output: "hi" }),
  })
  const deps = makeDeps(provider, {
    registry,
    createSnapshot: async () => "b".repeat(40),
  })
  await runUserTurn(deps, "run something")
  const { events } = SessionJournal.replay(deps.journal.path)
  const perCall = events.find((e) => e.type === "turn.snapshot" && "callId" in e && e.callId)
  expect(perCall && perCall.type === "turn.snapshot" ? perCall.tool : undefined).toBe("bash")
})

test("no createSnapshot configured: no snapshots at all, mutating calls still run", async () => {
  const provider = new MockProvider([
    [
      { type: "tool-call", callId: "c1", name: "echo", input: { text: "hi" } },
      { type: "finish", reason: "tool-calls", usage: usage1 },
    ],
    [
      { type: "text-delta", text: "done" },
      { type: "finish", reason: "stop", usage: usage2 },
    ],
  ])
  const deps = makeDeps(provider)
  await runUserTurn(deps, "go")
  const { events } = SessionJournal.replay(deps.journal.path)
  expect(events.some((e) => e.type === "turn.snapshot")).toBe(false)
})

test("maxSteps guard stops a runaway tool loop", async () => {
  const step = (n: number) => [
    { type: "tool-call" as const, callId: `c${n}`, name: "echo", input: { text: "again" } },
    { type: "finish" as const, reason: "tool-calls" as const, usage: usage1 },
  ]
  const provider = new MockProvider([step(1), step(2), step(3), step(4)])
  const deps = makeDeps(provider, { maxSteps: 3 })
  const outcome = await runUserTurn(deps, "loop forever")

  expect(outcome.steps).toBe(3)
  expect(provider.requests.length).toBe(3)
})
