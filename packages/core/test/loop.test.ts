import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { runGates } from "../src/loop/gates"
import { MAX_ATTEMPTS, WorkQueue } from "../src/loop/queue"
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
