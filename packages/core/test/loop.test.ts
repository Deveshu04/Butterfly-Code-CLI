import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { runGates } from "../src/loop/gates"
import { MAX_ATTEMPTS, WorkQueue } from "../src/loop/queue"
import type { LoopEvent } from "../src/loop/supervisor"
import { runLoop } from "../src/loop/supervisor"
import { ToolRegistry } from "../src/tool/registry"
import { MockProvider } from "./helpers/mock-provider"

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bfly-loop-"))
}

// --- WorkQueue ---

test("ready respects dependencies and closing unblocks", () => {
  const queue = WorkQueue.open(":memory:")
  const first = queue.addTask({ title: "schema", spec: "define the schema" })
  const second = queue.addTask({ title: "api", spec: "build the api", blockedBy: [first] })

  expect(queue.ready().map((t) => t.id)).toEqual([first])
  queue.claim(first)
  expect(queue.ready()).toEqual([])
  queue.close(first)
  expect(queue.ready().map((t) => t.id)).toEqual([second])
  queue.closeDb()
})

test("claim is atomic — a second claim loses", () => {
  const queue = WorkQueue.open(":memory:")
  const id = queue.addTask({ title: "t", spec: "s" })
  expect(queue.claim(id)).toBe(true)
  expect(queue.claim(id)).toBe(false)
  queue.closeDb()
})

test("release requeues with feedback until the attempt cap, then blocks", () => {
  const queue = WorkQueue.open(":memory:")
  const id = queue.addTask({ title: "flaky", spec: "do it" })
  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
    queue.claim(id)
    queue.release(id, `failure ${attempt}`)
    const task = queue.get(id)
    expect(task?.status).toBe("open")
    expect(task?.attempts).toBe(attempt)
    expect(task?.lastFailure).toBe(`failure ${attempt}`)
  }
  queue.claim(id)
  queue.release(id, "final failure")
  expect(queue.get(id)?.status).toBe("blocked")
  queue.closeDb()
})

test("reopening a queue resets stale claims from a crashed run", () => {
  const dir = tempDir()
  const path = join(dir, "queue.db")
  const queue = WorkQueue.open(path)
  const id = queue.addTask({ title: "t", spec: "s" })
  queue.claim(id)
  queue.closeDb()

  const reopened = WorkQueue.open(path)
  expect(reopened.get(id)?.status).toBe("open")
  expect(reopened.ready().map((t) => t.id)).toEqual([id])
  reopened.closeDb()
})

// --- gates ---

test("gates run serially and stop at the first failure", async () => {
  const result = await runGates(
    [
      { name: "ok", command: "echo fine" },
      { name: "boom", command: "exit 2" },
      { name: "never", command: "echo unreachable" },
    ],
    tempDir(),
  )
  expect(result.passed).toBe(false)
  expect(result.results.length).toBe(2)
  expect(result.results[1]?.exitCode).toBe(2)
}, 30_000)

// --- supervisor ---

function loopFixture(overrides: Partial<Parameters<typeof runLoop>[0]> = {}) {
  const dir = tempDir()
  const queue = WorkQueue.open(":memory:")
  const makeRegistry = () => {
    const registry = new ToolRegistry()
    registry.register({
      name: "echo",
      description: "Echoes text.",
      inputSchema: z.object({ text: z.string() }),
      execute: async (input) => ({ output: input.text }),
    })
    return registry
  }
  const commits: string[] = []
  const deps = {
    queue,
    makeRegistry,
    rules: { "*": "allow" } as const,
    model: "mock",
    system: "loop system",
    cwd: dir,
    gates: [],
    sessionsDir: join(dir, "sessions"),
    handoffPath: join(dir, "handoff.json"),
    commit: async (title: string) => {
      commits.push(title)
      return true
    },
    ...overrides,
  }
  return { queue, deps, commits, dir }
}

const stepUsage = { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0 }
const doneScript = (text: string) => [
  { type: "text-delta" as const, text },
  { type: "finish" as const, reason: "stop" as const, usage: stepUsage },
]

test("loop drains a dependent queue in order and commits per green task", async () => {
  const { queue, deps, commits } = loopFixture({
    provider: new MockProvider([doneScript("did schema"), doneScript("did api")]),
  })
  const first = queue.addTask({ title: "schema", spec: "define schema" })
  queue.addTask({ title: "api", spec: "build api", blockedBy: [first] })

  const outcome = await runLoop(deps as Parameters<typeof runLoop>[0])
  expect(outcome.stopReason).toBe("drained")
  expect(outcome.iterations).toBe(2)
  expect(outcome.closed).toBe(2)
  expect(commits).toEqual(["schema", "api"])
  expect(outcome.usage.input).toBe(2_000)
})

test("failing gates requeue with feedback and finally block", async () => {
  const scripts = Array.from({ length: MAX_ATTEMPTS }, (_, i) => doneScript(`attempt ${i + 1}`))
  const { queue, deps, commits } = loopFixture({
    provider: new MockProvider(scripts),
    gates: [{ name: "always-red", command: "exit 1" }],
  })
  queue.addTask({ title: "doomed", spec: "cannot pass" })

  const outcome = await runLoop(deps as Parameters<typeof runLoop>[0])
  expect(outcome.stopReason).toBe("all-blocked")
  expect(outcome.blocked).toBe(1)
  expect(commits).toEqual([])
}, 60_000)

test("budget ceiling stops the loop between iterations", async () => {
  const { queue, deps } = loopFixture({
    provider: new MockProvider([doneScript("one"), doneScript("two")]),
    budgetTokens: 1_500,
  })
  queue.addTask({ title: "a", spec: "a" })
  queue.addTask({ title: "b", spec: "b" })

  const outcome = await runLoop(deps as Parameters<typeof runLoop>[0])
  expect(outcome.stopReason).toBe("budget")
  expect(outcome.iterations).toBe(1)
})


test("onEvent streams the structured, typed event sequence for a green task", async () => {
  const { queue, deps } = loopFixture({
    provider: new MockProvider([doneScript("did it")]),
    gates: [{ name: "ok", command: "exit 0" }],
  })
  queue.addTask({ title: "solo", spec: "just do it" })
  const seen: LoopEvent[] = []

  const outcome = await runLoop({
    ...deps,
    onEvent: (event) => seen.push(event),
  } as Parameters<typeof runLoop>[0])

  expect(outcome.stopReason).toBe("drained")
  expect(seen.map((e) => e.type)).toEqual([
    "loop.started",
    "task.claimed",
    "gate.result",
    "task.closed",
    "loop.stopped",
  ])
  const claimed = seen[1]
  if (claimed?.type !== "task.claimed") throw new Error("expected task.claimed")
  expect(claimed.title).toBe("solo")
  expect(claimed.progress.iterations).toBe(1)
  expect(claimed.progress.counts.claimed).toBe(1)
  const closed = seen[3]
  if (closed?.type !== "task.closed") throw new Error("expected task.closed")
  expect(closed.committed).toBe(true)
  expect(closed.progress.counts.closed).toBe(1)
  expect(closed.progress.usage.input).toBe(1_000)
  const stopped = seen[4]
  if (stopped?.type !== "loop.stopped") throw new Error("expected loop.stopped")
  expect(stopped.reason).toBe("drained")
  expect(stopped.progress.iterations).toBe(1)
})

test("a signal aborted before the loop starts stops immediately, task untouched", async () => {
  const { queue, deps } = loopFixture({
    provider: new MockProvider([doneScript("never runs")]),
  })
  const id = queue.addTask({ title: "untouched", spec: "should not start" })
  const controller = new AbortController()
  controller.abort()

  const outcome = await runLoop({
    ...deps,
    signal: controller.signal,
  } as Parameters<typeof runLoop>[0])

  expect(outcome.stopReason).toBe("interrupted")
  expect(outcome.iterations).toBe(0)
  expect(queue.get(id)?.status).toBe("open")
})

test("a signal aborted mid-iteration abandons that iteration (no commit) and leaves it claimed for resume", async () => {
  const { queue, deps } = loopFixture({
    provider: new MockProvider([doneScript("first")]),
    gates: [{ name: "ok", command: "exit 0" }],
  })
  const first = queue.addTask({ title: "first", spec: "do first" })
  const second = queue.addTask({ title: "second", spec: "should not start" })
  const controller = new AbortController()
  const seen: LoopEvent[] = []

  const outcome = await runLoop({
    ...deps,
    signal: controller.signal,
    onEvent: (event) => {
      seen.push(event)
      if (event.type === "task.claimed") controller.abort()
    },
  } as Parameters<typeof runLoop>[0])

  expect(outcome.stopReason).toBe("interrupted")
  expect(outcome.iterations).toBe(1)
  expect(outcome.closed).toBe(0)
  expect(queue.get(first)?.status).toBe("claimed")
  // The second task was never even reached.
  expect(queue.get(second)?.status).toBe("open")
  expect(seen.map((e) => e.type)).toEqual(["loop.started", "task.claimed", "loop.stopped"])
})

test("the task prompt carries prior gate feedback on retry", async () => {
  const provider = new MockProvider([doneScript("first try"), doneScript("second try")])
  const { queue, deps } = loopFixture({
    provider,
    gates: [{ name: "red", command: "exit 1" }],
    maxIterations: 2,
  })
  queue.addTask({ title: "learn", spec: "make it pass" })

  await runLoop(deps as Parameters<typeof runLoop>[0])
  const secondRequest = provider.requests[1]
  const userMessage = secondRequest?.messages.find((m) => m.role === "user")
  const content = userMessage && "content" in userMessage ? userMessage.content : ""
  expect(content).toContain("red")
}, 60_000)
