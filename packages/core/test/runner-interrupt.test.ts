import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { ProviderPort } from "../src/provider/port"
import { now, type SessionEvent } from "../src/session/events"
import { SessionJournal } from "../src/session/journal"
import { type RunnerDeps, runUserTurn } from "../src/session/runner"
import { ToolRegistry } from "../src/tool/registry"
import { MockProvider } from "./helpers/mock-provider"

/**
 * An interrupted turn must never leave a journaled tool.call without a
 * tool.result: the runner synthesizes results for calls it never ran, and
 * assembly.ts repairs older journals on replay (see the /resume test below).
 */

function makeDeps(provider: MockProvider, overrides: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    provider,
    registry: new ToolRegistry(),
    journal: SessionJournal.create(mkdtempSync(join(tmpdir(), "bfly-interrupt-"))),
    rules: { "*": "allow" },
    model: "mock-model",
    system: "s",
    cwd: "/w",
    ...overrides,
  }
}

/** Every journaled tool.call must have exactly one paired tool.result. */
function assertPaired(events: SessionEvent[]): void {
  const calls = events
    .filter((e) => e.type === "tool.call")
    .map((e) => (e as { callId: string }).callId)
  const results = events
    .filter((e) => e.type === "tool.result")
    .map((e) => (e as { callId: string }).callId)
  expect(results).toEqual(calls)
}

test("signal already aborted before the batch starts: every call is abandoned as interrupted, none execute", async () => {
  const provider = new MockProvider([
    [
      { type: "tool-call", callId: "c1", name: "echo", input: { text: "one" } },
      { type: "tool-call", callId: "c2", name: "echo", input: { text: "two" } },
      {
        type: "finish",
        reason: "tool-calls",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  ])
  let executions = 0
  const registry = new ToolRegistry()
  registry.register({
    name: "echo",
    description: "e",
    inputSchema: z.object({ text: z.string() }),
    execute: async (input) => {
      executions += 1
      return { output: `echo: ${input.text}` }
    },
  })
  const abort = new AbortController()
  abort.abort()
  const deps = makeDeps(provider, { registry, signal: abort.signal })
  const outcome = await runUserTurn(deps, "go")

  expect(outcome.interrupted).toBe(true)
  expect(executions).toBe(0)
  const { events } = SessionJournal.replay(deps.journal.path)
  assertPaired(events)
  const results = events.filter((e) => e.type === "tool.result")
  expect(results.every((r) => "output" in r && r.output === "[not executed — interrupted]")).toBe(
    true,
  )
  expect(results.every((r) => "isError" in r && r.isError === true)).toBe(true)
})

test("interrupt mid-tool (execute() in-flight when the signal fires): the in-flight call AND every call after it are abandoned, journal stays paired, no throw", async () => {
  const provider = new MockProvider([
    [
      { type: "tool-call", callId: "c1", name: "slow", input: { text: "one" } },
      { type: "tool-call", callId: "c2", name: "echo", input: { text: "two" } },
      {
        type: "finish",
        reason: "tool-calls",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  ])
  const slowStarted: string[] = []
  let releaseSlow: (() => void) | undefined
  let echoExecutions = 0
  const registry = new ToolRegistry()
  registry.register({
    name: "slow",
    description: "a tool that hangs until released — simulates a real in-flight execute()",
    inputSchema: z.object({ text: z.string() }),
    execute: async (input) => {
      slowStarted.push(input.text)
      await new Promise<void>((resolve) => {
        releaseSlow = resolve
      })
      return { output: `slow done: ${input.text}` }
    },
  })
  registry.register({
    name: "echo",
    description: "e",
    inputSchema: z.object({ text: z.string() }),
    execute: async (input) => {
      echoExecutions += 1
      return { output: `echo: ${input.text}` }
    },
  })

  const abort = new AbortController()
  const deps = makeDeps(provider, { registry, signal: abort.signal })
  const turn = runUserTurn(deps, "go")

  // Wait until "slow" is mid-execute() before interrupting: the case of a
  // call in flight when the signal fires.
  for (let i = 0; i < 100 && slowStarted.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 5))
  }
  expect(slowStarted).toEqual(["one"]) // sanity: it really did start before we abort

  abort.abort()
  const outcome = await turn

  expect(outcome.interrupted).toBe(true)
  expect(echoExecutions).toBe(0) // c2 never even attempted
  const { events } = SessionJournal.replay(deps.journal.path)
  assertPaired(events)
  const results = events.filter((e) => e.type === "tool.result")
  expect(results.map((r) => ("callId" in r ? r.callId : ""))).toEqual(["c1", "c2"])
  for (const r of results) {
    expect("output" in r ? r.output : "").toBe("[not executed — interrupted]")
    expect("isError" in r ? r.isError : false).toBe(true)
  }

  // Cleanup: let the abandoned "slow" execute() finish so it doesn't linger.
  releaseSlow?.()
})

test("an interrupted turn resolves (does not throw/reject) even though the provider was mid-way through tool-calls", async () => {
  const provider = new MockProvider([
    [
      { type: "tool-call", callId: "c1", name: "echo", input: { text: "x" } },
      {
        type: "finish",
        reason: "tool-calls",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  ])
  const registry = new ToolRegistry()
  registry.register({
    name: "echo",
    description: "e",
    inputSchema: z.object({ text: z.string() }),
    execute: async (input) => ({ output: `echo: ${input.text}` }),
  })
  const abort = new AbortController()
  abort.abort()
  const deps = makeDeps(provider, { registry, signal: abort.signal })
  // Must not throw.
  const outcome = await runUserTurn(deps, "go")
  expect(outcome.budgetExceeded).toBe(false)
  expect(outcome.interrupted).toBe(true)
})

/**
 * A journal with a dangling tool.call written directly to disk (as a hard
 * kill could leave) must still assemble into a provider-valid request for the
 * next turn, with no assistant tool call lacking its tool message.
 */
test("/resume-then-turn E2E: an old dangling tool.call heals at assembly for the next turn's provider request", async () => {
  const journal = SessionJournal.create(mkdtempSync(join(tmpdir(), "bfly-resume-")))
  journal.append({ type: "message.user", id: "u1", text: "do the thing", time: now() })
  journal.append({ type: "message.assistant", id: "a1", text: "", time: now() })
  journal.append({
    type: "tool.call",
    callId: "stale-1",
    name: "bash",
    input: { command: "long-running" },
    time: now(),
  })
  // (deliberately no tool.result — the corruption)

  const provider = new MockProvider([
    [
      { type: "text-delta", text: "continuing" },
      {
        type: "finish",
        reason: "stop",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  ])
  const deps: RunnerDeps = {
    provider,
    registry: new ToolRegistry(),
    journal,
    rules: { "*": "allow" },
    model: "mock-model",
    system: "s",
    cwd: "/w",
  }
  const outcome = await runUserTurn(deps, "keep going")
  expect(outcome.text).toBe("continuing")

  const sent = provider.requests[0]?.messages ?? []
  const called = new Set<string>()
  const answered = new Set<string>()
  for (const message of sent) {
    if (message.role === "assistant")
      for (const call of message.toolCalls ?? []) called.add(call.callId)
    if (message.role === "tool") answered.add(message.callId)
  }
  expect(called.has("stale-1")).toBe(true)
  expect([...called].every((id) => answered.has(id))).toBe(true)
})

/**
 * A provider whose stream resolves cleanly on abort (no error part, as the AI
 * SDK does) must still report `outcome.interrupted`, even though it lands via
 * the non-tool-calls finish path rather than the retry loop's failure path.
 */
test("abort during provider streaming (no error part, clean synthetic finish) is still reported as interrupted", async () => {
  const provider: ProviderPort = {
    async *streamTurn(request) {
      yield { type: "tool-call", callId: "c1", name: "echo", input: {} }
      if (request.signal?.aborted) {
        yield {
          type: "finish",
          reason: "stop",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }
        return
      }
      yield {
        type: "finish",
        reason: "tool-calls",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }
    },
  }
  const abort = new AbortController()
  abort.abort()
  const deps: RunnerDeps = {
    provider,
    registry: new ToolRegistry(),
    journal: SessionJournal.create(mkdtempSync(join(tmpdir(), "bfly-interrupt-"))),
    rules: { "*": "allow" },
    model: "mock-model",
    system: "s",
    cwd: "/w",
    signal: abort.signal,
  }
  const outcome = await runUserTurn(deps, "go")
  expect(outcome.interrupted).toBe(true)
  const { events } = SessionJournal.replay(deps.journal.path)
  assertPaired(events) // c1 was journaled (assistant emitted it) then abandoned — never dangling
})
