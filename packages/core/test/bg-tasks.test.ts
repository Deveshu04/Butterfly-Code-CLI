import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionEvent } from "../src/session/events"
import { BgTaskRegistry } from "../src/tool/bg-tasks"


function fixtureDir(): string {
  return mkdtempSync(join(tmpdir(), "bfly-bgtasks-"))
}

function makeRegistry(
  extra: Partial<{ journal: { append(e: SessionEvent): void }; logCapBytes: number }> = {},
): BgTaskRegistry {
  const dir = fixtureDir()
  const registry = new BgTaskRegistry({ cwd: dir, logDir: join(dir, ".butterfly", "bg"), ...extra })
  liveRegistries.push(registry)
  return registry
}

const liveRegistries: BgTaskRegistry[] = []
afterEach(() => {
  for (const registry of liveRegistries.splice(0)) {
    for (const task of registry.list()) {
      if (task.status === "running") registry.kill(task.id)
    }
  }
})

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out")
    await new Promise((r) => setTimeout(r, 25))
  }
}

test("spawn returns immediately with a task id and pid — before the command finishes", () => {
  const registry = makeRegistry()
  const before = Date.now()
  const record = registry.spawn("sleep 5")
  expect(Date.now() - before).toBeLessThan(1_000)
  expect(record.id).toBeTruthy()
  expect(record.pid).toBeGreaterThan(0)
  expect(record.status).toBe("running")
  expect(record.command).toBe("sleep 5")
}, 20_000)

test("list surfaces spawned tasks, running and finished alike", async () => {
  const registry = makeRegistry()
  const record = registry.spawn("echo hi")
  expect(registry.list().map((t) => t.id)).toContain(record.id)
  await waitFor(() => registry.get(record.id)?.status !== "running")
  expect(registry.list().map((t) => t.id)).toContain(record.id)
  expect(registry.get(record.id)?.status).toBe("exited")
  expect(registry.get(record.id)?.exitCode).toBe(0)
}, 20_000)

test("kill stops a running task via the same tree-kill path as foreground bash", async () => {
  const registry = makeRegistry()
  const record = registry.spawn("sleep 30")
  expect(registry.kill(record.id)).toBe(true)
  expect(registry.get(record.id)?.status).toBe("killed")
  // Killing an unknown/already-finished id reports false, never throws.
  expect(registry.kill("nope")).toBe(false)
}, 20_000)

test("reap kills every running task except keepAlive ones", async () => {
  const registry = makeRegistry()
  const normal = registry.spawn("sleep 30")
  const kept = registry.spawn("sleep 30", { keepAlive: true })
  const killed = registry.reap()
  expect(killed).toEqual([normal.id])
  expect(registry.get(normal.id)?.status).toBe("killed")
  expect(registry.get(kept.id)?.status).toBe("running")
}, 20_000)

test("output logs are capped on disk, with a truncation notice appended", async () => {
  const registry = makeRegistry({ logCapBytes: 40 })
  const line = "0123456789".repeat(10)
  const record = registry.spawn(`echo ${line}`)
  await waitFor(() => registry.get(record.id)?.status !== "running")
  const content = readFileSync(record.logPath, "utf8")
  expect(content.length).toBeLessThan(200)
  expect(content).toContain("truncated")
}, 20_000)

test("tail returns at most maxChars from the end of the log", async () => {
  const registry = makeRegistry()
  const record = registry.spawn("echo short-output")
  await waitFor(() => registry.get(record.id)?.status !== "running")
  const tail = registry.tail(record.id, 5)
  expect(tail?.length).toBeLessThanOrEqual(5)
  expect(registry.tail("nope")).toBeUndefined()
}, 20_000)

test("a supplied journal sink receives bgtask.start and bgtask.end", async () => {
  const events: SessionEvent[] = []
  const registry = makeRegistry({ journal: { append: (e) => events.push(e) } })
  const record = registry.spawn("echo journaled")
  const startEvent = events.find((e) => e.type === "bgtask.start")
  expect(startEvent && "id" in startEvent ? startEvent.id : undefined).toBe(record.id)
  await waitFor(() => registry.get(record.id)?.status !== "running")
  const endEvent = events.find((e) => e.type === "bgtask.end")
  expect(endEvent && "id" in endEvent ? endEvent.id : undefined).toBe(record.id)
  expect(endEvent && "status" in endEvent ? endEvent.status : undefined).toBe("exited")
}, 20_000)

test("registry works with no journal supplied at all (best-effort, optional)", async () => {
  const registry = makeRegistry()
  const record = registry.spawn("echo no-journal")
  await waitFor(() => registry.get(record.id)?.status !== "running")
  expect(registry.get(record.id)?.status).toBe("exited")
}, 20_000)
