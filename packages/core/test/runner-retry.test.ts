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


test("an already-aborted signal short-circuits the backoff — fails fast, never retries", async () => {
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
  const deps = makeDeps(provider, { signal: abort.signal })
  const start = Date.now()
  await expect(runUserTurn(deps, "go")).rejects.toThrow("Provider error: network blip")
  expect(Date.now() - start).toBeLessThan(500)
  expect(provider.requests.length).toBe(1)
})

test("abort fired MID-backoff cancels the wait immediately rather than running the full 2s out", async () => {
  const provider = new MockProvider([
    [
      {
        type: "error",
        message: "slow provider",
        info: { kind: "unavailable", message: "slow provider" },
      },
    ],
  ])
  const abort = new AbortController()
  const deps = makeDeps(provider, { signal: abort.signal })
  setTimeout(() => abort.abort(), 20)
  const start = Date.now()
  await expect(runUserTurn(deps, "go")).rejects.toThrow("Provider error: slow provider")
  const elapsed = Date.now() - start
  expect(elapsed).toBeGreaterThanOrEqual(15)
  expect(elapsed).toBeLessThan(1_900) // the full base-2s(*2^0) ceiling never ran out
  expect(provider.requests.length).toBe(1) // the abort pre-empted the retry entirely
})
