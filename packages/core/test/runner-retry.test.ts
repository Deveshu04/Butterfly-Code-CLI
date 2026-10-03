import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionJournal } from "../src/session/journal"
import {
  computeRetryBackoffMs,
  type RunnerDeps,
  type RunnerEvent,
  runUserTurn,
} from "../src/session/runner"
import { ToolRegistry } from "../src/tool/registry"
import { MockProvider } from "./helpers/mock-provider"


function makeDeps(provider: MockProvider, overrides: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    provider,
    registry: new ToolRegistry(),
    journal: SessionJournal.create(mkdtempSync(join(tmpdir(), "bfly-retry-"))),
    rules: { "*": "allow" },
    model: "mock-model",
    system: "s",
    cwd: "/w",
    ...overrides,
  }
}

const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }


test("computeRetryBackoffMs doubles the jitter ceiling per attempt (base 2s, x2)", () => {
  for (let i = 0; i < 25; i++) {
    const w1 = computeRetryBackoffMs(1)
    expect(w1).toBeGreaterThanOrEqual(0)
    expect(w1).toBeLessThanOrEqual(2_000)
    const w2 = computeRetryBackoffMs(2)
    expect(w2).toBeLessThanOrEqual(4_000)
    const w3 = computeRetryBackoffMs(3)
    expect(w3).toBeLessThanOrEqual(8_000)
  }
})

test("computeRetryBackoffMs honors retryAfterSec over the computed backoff, regardless of attempt", () => {
  expect(computeRetryBackoffMs(1, 5)).toBe(5_000)
  expect(computeRetryBackoffMs(9, 5)).toBe(5_000)
  expect(computeRetryBackoffMs(1, 0)).toBe(0)
})


test("a retried step's journal reflects ONLY the successful attempt — nothing from the failed one leaks in", async () => {
  const provider = new MockProvider([
    [
      { type: "text-delta", text: "partial garbage from a doomed attempt" },
      { type: "tool-call", callId: "ghost-call", name: "echo", input: { text: "never happened" } },
      {
        type: "error",
        message: "upstream overloaded",
        info: { kind: "unavailable", message: "upstream overloaded", retryAfterSec: 0 },
      },
    ],
    [
      { type: "text-delta", text: "all good" },
      { type: "finish", reason: "stop", usage },
    ],
  ])
  const notices: string[] = []
  const deps = makeDeps(provider, {
    onEvent: (event) => {
      if (event.type === "notice") notices.push(event.text)
    },
  })
  const outcome = await runUserTurn(deps, "go")

  expect(outcome.text).toBe("all good")
  expect(provider.requests.length).toBe(2)
  expect(notices.some((n) => n.startsWith("retrying (1/3)"))).toBe(true)

  const { events } = SessionJournal.replay(deps.journal.path)
  const assistantTexts = events.filter((e) => e.type === "message.assistant").map((e) => e.text)
  expect(assistantTexts).toEqual(["all good"])
  expect(events.some((e) => e.type === "tool.call")).toBe(false)
  expect(JSON.stringify(events)).not.toContain("ghost-call")
  expect(JSON.stringify(events)).not.toContain("doomed")
})


test("a rate_limit failure is retried and the notice names the provider and the wait", async () => {
  const provider = new MockProvider([
    [
      {
        type: "error",
        message: "rate limited",
        info: {
          kind: "rate_limit",
          message: "rate limited",
          provider: "openrouter",
          retryAfterSec: 1,
        },
      },
    ],
    [
      { type: "text-delta", text: "ok" },
      { type: "finish", reason: "stop", usage },
    ],
  ])
  const notices: string[] = []
  const deps = makeDeps(provider, {
    onEvent: (event) => {
      if (event.type === "notice") notices.push(event.text)
    },
  })
  const outcome = await runUserTurn(deps, "go")
  expect(outcome.text).toBe("ok")
  expect(notices[0]).toBe("retrying (1/3) in 1s — rate limited by openrouter")
})

for (const kind of ["rate_limit", "unavailable", "timeout", "network"] as const) {
  test(`${kind} is retried (one retry, then success)`, async () => {
    const provider = new MockProvider([
      [
        {
          type: "error",
          message: "transient",
          info: { kind, message: "transient", retryAfterSec: 0 },
        },
      ],
      [
        { type: "text-delta", text: "recovered" },
        { type: "finish", reason: "stop", usage },
      ],
    ])
    const deps = makeDeps(provider)
    const outcome = await runUserTurn(deps, "go")
    expect(outcome.text).toBe("recovered")
    expect(provider.requests.length).toBe(2)
  })
}


for (const kind of ["auth", "quota", "bad_request", "context_length", "unknown"] as const) {
  test(`${kind} is NOT retried — fails on the first attempt with the usual throw shape`, async () => {
    const provider = new MockProvider([
      [{ type: "error", message: "nope", info: { kind, message: "nope" } }],
    ])
    const seen: RunnerEvent[] = []
    const deps = makeDeps(provider, { onEvent: (event) => seen.push(event) })
    await expect(runUserTurn(deps, "go")).rejects.toThrow("Provider error: nope")
    expect(provider.requests.length).toBe(1)
    expect(seen.some((e) => e.type === "error")).toBe(true)
    expect(seen.some((e) => e.type === "notice")).toBe(false)
  })
}

test("an error with no `info` (unclassified) is treated as non-retryable", async () => {
  const provider = new MockProvider([[{ type: "error", message: "mystery failure" }]])
  const deps = makeDeps(provider)
  await expect(runUserTurn(deps, "go")).rejects.toThrow("Provider error: mystery failure")
  expect(provider.requests.length).toBe(1)
})


test("retries exhausted (default cap 3) still throws 'Provider error: ...' unchanged in shape", async () => {
  const failStep = () => [
    {
      type: "error" as const,
      message: "still rate limited",
      info: { kind: "rate_limit" as const, message: "still rate limited", retryAfterSec: 0 },
    },
  ]
  const provider = new MockProvider([failStep(), failStep(), failStep(), failStep()])
  const notices: string[] = []
  const deps = makeDeps(provider, {
    onEvent: (event) => {
      if (event.type === "notice") notices.push(event.text)
    },
  })
  await expect(runUserTurn(deps, "go")).rejects.toThrow("Provider error: still rate limited")
  // 1 initial attempt + 3 retries = 4 total requests.
  expect(provider.requests.length).toBe(4)
  expect(notices).toEqual([
    "retrying (1/3) in 0s — rate limited",
    "retrying (2/3) in 0s — rate limited",
    "retrying (3/3) in 0s — rate limited",
  ])
})

test("deps.retries overrides the default cap", async () => {
  const failStep = () => [
    {
      type: "error" as const,
      message: "timeout",
      info: { kind: "timeout" as const, message: "timeout" },
    },
  ]
  const provider = new MockProvider([failStep(), failStep()])
  const deps = makeDeps(provider, { retries: 1 })
  await expect(runUserTurn(deps, "go")).rejects.toThrow("Provider error: timeout")
  expect(provider.requests.length).toBe(2) // 1 initial + 1 retry only
})

test("retries: 0 disables step retry entirely — one attempt, then the usual throw", async () => {
  const provider = new MockProvider([
    [
      {
        type: "error",
        message: "rate limited",
        info: { kind: "rate_limit", message: "rate limited", retryAfterSec: 0 },
      },
    ],
  ])
  const seen: RunnerEvent[] = []
  const deps = makeDeps(provider, { retries: 0, onEvent: (event) => seen.push(event) })
  await expect(runUserTurn(deps, "go")).rejects.toThrow("Provider error: rate limited")
  expect(provider.requests.length).toBe(1)
  expect(seen.some((e) => e.type === "notice")).toBe(false)
  expect(seen.some((e) => e.type === "error")).toBe(true)
})


test("an already-aborted signal short-circuits the backoff — settles interrupted, fails fast, never retries", async () => {
  const provider = new MockProvider([
    [
      {
        type: "error",
        message: "network blip",
        info: { kind: "network", message: "network blip" },
      },
    ],
  ])
  const abort = new AbortController()
  abort.abort()
  const seen: RunnerEvent[] = []
  const deps = makeDeps(provider, { signal: abort.signal, onEvent: (event) => seen.push(event) })
  const start = Date.now()
  const outcome = await runUserTurn(deps, "go")
  expect(outcome.interrupted).toBe(true)
  expect(Date.now() - start).toBeLessThan(500)
  expect(provider.requests.length).toBe(1)
  expect(seen.some((e) => e.type === "error")).toBe(false)
})

test("abort fired MID-backoff cancels the wait immediately rather than running the full 2s out", async () => {
  const provider = new MockProvider([
    [
      {
        type: "error",
        message: "slow provider",
        // retryAfterSec pins the backoff: full jitter can draw < 20ms,
        // letting the retry fire before the abort (a ~1% flake).
        info: { kind: "unavailable", message: "slow provider", retryAfterSec: 1 },
      },
    ],
  ])
  const abort = new AbortController()
  const deps = makeDeps(provider, { signal: abort.signal })
  setTimeout(() => abort.abort(), 20)
  const start = Date.now()
  const outcome = await runUserTurn(deps, "go")
  const elapsed = Date.now() - start
  expect(outcome.interrupted).toBe(true)
  expect(elapsed).toBeGreaterThanOrEqual(15)
  expect(elapsed).toBeLessThan(1_900) // the full base-2s(*2^0) ceiling never ran out
  expect(provider.requests.length).toBe(1) // the abort pre-empted the retry entirely
})

test("an abort mid-backoff journals turn.completed and nothing for the doomed step", async () => {
  const provider = new MockProvider([
    [
      { type: "text-delta", text: "half a sentence that never lands" },
      { type: "tool-call", callId: "ghost", name: "echo", input: {} },
      {
        type: "error",
        message: "overloaded",
        info: { kind: "unavailable", message: "overloaded", retryAfterSec: 1 },
      },
    ],
  ])
  const abort = new AbortController()
  const seen: RunnerEvent[] = []
  const deps = makeDeps(provider, { signal: abort.signal, onEvent: (event) => seen.push(event) })
  setTimeout(() => abort.abort(), 20)
  const outcome = await runUserTurn(deps, "go")

  expect(outcome.interrupted).toBe(true)
  expect(outcome.text).toBe("") // the doomed attempt's text is NOT the turn's text
  const { events } = SessionJournal.replay(deps.journal.path)
  // Exactly one turn.completed, and the interrupted step left no assistant
  // message and no dangling tool.call behind it.
  expect(events.filter((e) => e.type === "turn.completed").length).toBe(1)
  expect(events.some((e) => e.type === "message.assistant")).toBe(false)
  expect(events.some((e) => e.type === "tool.call")).toBe(false)
  // A user abort is not a provider failure: no error event reached the UI.
  expect(seen.some((e) => e.type === "error")).toBe(false)
})


test("a failed attempt emits step-retracted BEFORE its retry notice, so the UI drops the ghost first", async () => {
  const provider = new MockProvider([
    [
      { type: "text-delta", text: "ghost text" },
      { type: "tool-call", callId: "ghost-call", name: "echo", input: {} },
      {
        type: "error",
        message: "overloaded",
        info: { kind: "unavailable", message: "overloaded", retryAfterSec: 0 },
      },
    ],
    [
      { type: "text-delta", text: "real answer" },
      { type: "finish", reason: "stop", usage },
    ],
  ])
  const seen: RunnerEvent[] = []
  const deps = makeDeps(provider, { onEvent: (event) => seen.push(event) })
  const outcome = await runUserTurn(deps, "go")
  expect(outcome.text).toBe("real answer")

  const types = seen.map((e) => e.type)
  const retracted = types.indexOf("step-retracted")
  expect(retracted).toBeGreaterThan(-1)
  expect(types.indexOf("text-delta")).toBeLessThan(retracted)
  expect(types.indexOf("tool-call")).toBeLessThan(retracted)
  expect(types.indexOf("notice")).toBeGreaterThan(retracted)
  const event = seen[retracted]
  expect(event).toEqual({ type: "step-retracted", attempt: 1 })
  // Exactly one retraction — the successful attempt is never retracted.
  expect(types.filter((t) => t === "step-retracted").length).toBe(1)
})

test("a clean turn emits no step-retracted at all", async () => {
  const provider = new MockProvider([
    [
      { type: "text-delta", text: "fine" },
      { type: "finish", reason: "stop", usage },
    ],
  ])
  const seen: RunnerEvent[] = []
  const deps = makeDeps(provider, { onEvent: (event) => seen.push(event) })
  await runUserTurn(deps, "go")
  expect(seen.some((e) => e.type === "step-retracted")).toBe(false)
})

test("a FINAL failure does NOT retract — nothing is coming to replace what it streamed", async () => {
  const provider = new MockProvider([
    [
      { type: "text-delta", text: "ghost text" },
      { type: "error", message: "nope", info: { kind: "auth", message: "nope" } },
    ],
  ])
  const seen: RunnerEvent[] = []
  const deps = makeDeps(provider, { onEvent: (event) => seen.push(event) })
  await expect(runUserTurn(deps, "go")).rejects.toThrow("Provider error: nope")
  expect(seen.map((e) => e.type)).toEqual(["text-delta", "error"])
})

test("retries EXHAUSTED does not retract the last attempt either — only the ones actually re-run", async () => {
  const failStep = () => [
    { type: "text-delta" as const, text: "partial" },
    {
      type: "error" as const,
      message: "still overloaded",
      info: { kind: "unavailable" as const, message: "still overloaded", retryAfterSec: 0 },
    },
  ]
  const provider = new MockProvider([failStep(), failStep()])
  const seen: RunnerEvent[] = []
  const deps = makeDeps(provider, { retries: 1, onEvent: (event) => seen.push(event) })
  await expect(runUserTurn(deps, "go")).rejects.toThrow("Provider error: still overloaded")
  // Attempt 1 was retried (retracted); attempt 2 was the end of the road.
  expect(seen.map((e) => e.type)).toEqual([
    "text-delta",
    "step-retracted",
    "notice",
    "text-delta",
    "error",
  ])
})

test("the retraction's attempt number tracks the attempt that failed", async () => {
  const failStep = () => [
    {
      type: "error" as const,
      message: "still overloaded",
      info: { kind: "unavailable" as const, message: "still overloaded", retryAfterSec: 0 },
    },
  ]
  const provider = new MockProvider([
    failStep(),
    failStep(),
    [
      { type: "text-delta", text: "third time lucky" },
      { type: "finish", reason: "stop", usage },
    ],
  ])
  const attempts: number[] = []
  const deps = makeDeps(provider, {
    onEvent: (event) => {
      if (event.type === "step-retracted") attempts.push(event.attempt)
    },
  })
  await runUserTurn(deps, "go")
  expect(attempts).toEqual([1, 2])
})
