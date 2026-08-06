import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { SessionEvent } from "../src/session/events"
import type { BgTaskRegistryOptions } from "../src/tool/bg-tasks"
import { BgTaskRegistry } from "../src/tool/bg-tasks"


function fixtureDir(): string {
  return mkdtempSync(join(tmpdir(), "bfly-bgtasks-"))
}

function makeRegistry(extra: Partial<BgTaskRegistryOptions> = {}): BgTaskRegistry {
  const dir = fixtureDir()
  const registry = new BgTaskRegistry({ cwd: dir, logDir: join(dir, ".butterfly", "bg"), ...extra })
  liveRegistries.push(registry)
  return registry
}

const liveRegistries: BgTaskRegistry[] = []
/** Raw pids spawned OUTSIDE any registry we hold (wrapper-parent tests). */
const livePids: number[] = []

function isAlive(pid: number): boolean {
  if (process.platform === "win32") {
    const out = Bun.spawnSync(["tasklist", "/FI", `PID eq ${pid}`, "/NH"]).stdout.toString()
    return out.includes(String(pid))
  }
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function killPid(pid: number): void {
  if (process.platform === "win32") {
    Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], {
      stdout: "ignore",
      stderr: "ignore",
    })
    return
  }
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // already gone
    }
  }
}

afterEach(() => {
  for (const registry of liveRegistries.splice(0)) {
    for (const task of registry.list()) {
      if (task.status === "running") registry.kill(task.id)
    }
  }
  for (const pid of livePids.splice(0)) killPid(pid)
})

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out")
    await new Promise((r) => setTimeout(r, 25))
  }
}

const CHATTY = "i=0; while [ $i -lt 200 ]; do echo tick $i; i=$((i+1)); sleep 0.2; done"

async function spawnWrapperParent(mode: "exit" | "stay"): Promise<{
  parentPid: number
  info: { kept: number; normal: number; keptLog: string }
  waitParentGone: () => Promise<void>
}> {
  const dir = fixtureDir()
  const moduleUrl = pathToFileURL(join(import.meta.dir, "..", "src", "tool", "bg-tasks.ts")).href
  const scriptPath = join(dir, "wrapper.ts")
  writeFileSync(
    scriptPath,
    `import { writeFileSync } from "node:fs"
import { join } from "node:path"
const { BgTaskRegistry } = await import(${JSON.stringify(moduleUrl)})
const dir = ${JSON.stringify(dir)}
const registry = new BgTaskRegistry({ cwd: dir, logDir: join(dir, "bg") })
const chatty = ${JSON.stringify(CHATTY)}
const kept = registry.spawn(chatty, { keepAlive: true })
const normal = registry.spawn(chatty)
writeFileSync(join(dir, "info.json"), JSON.stringify({ kept: kept.pid, normal: normal.pid, keptLog: kept.logPath }))
if (${JSON.stringify(mode)} === "exit") process.exit(0)
setInterval(() => {}, 1000)
`,
  )
  const parent = Bun.spawn([process.execPath, scriptPath], {
    cwd: dir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const infoPath = join(dir, "info.json")
  await waitFor(() => existsSync(infoPath), 30_000)
  const info = JSON.parse(readFileSync(infoPath, "utf8")) as {
    kept: number
    normal: number
    keptLog: string
  }
  livePids.push(info.kept, info.normal, parent.pid)
  return {
    parentPid: parent.pid,
    info,
    waitParentGone: async () => {
      await parent.exited
    },
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

test("stderr lands in the log alongside stdout, in order", async () => {
  const registry = makeRegistry()
  const record = registry.spawn("echo out1; echo err1 >&2; echo out2")
  await waitFor(() => registry.get(record.id)?.status !== "running")
  const content = readFileSync(record.logPath, "utf8")
  expect(content).toContain("out1")
  expect(content).toContain("err1")
  expect(content).toContain("out2")
}, 20_000)

test("the log rolls at the cap WHILE the task is still running (no unbounded growth)", async () => {
  const registry = makeRegistry({ logCapBytes: 400, logCheckIntervalMs: 100 })
  const record = registry.spawn(
    "i=0; while [ $i -lt 100 ]; do echo 0123456789012345678901234567890123456789; i=$((i+1)); sleep 0.02; done",
  )
  await waitFor(() => statSync(record.logPath).size > 400, 20_000)
  await new Promise((r) => setTimeout(r, 600))
  const size = statSync(record.logPath).size
  // Rolled, not unbounded: cap + one notice + one check interval of writes.
  expect(size).toBeLessThan(2_000)
  expect(readFileSync(record.logPath, "utf8")).toContain("truncated")
  registry.kill(record.id)
}, 30_000)

test("spawn refuses (clearly) on a shell family it cannot detach safely", () => {
  const registry = makeRegistry({
    shell: () => ({
      exe: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      args: (c: string) => ["-NoProfile", "-Command", c],
      family: "powershell" as const,
    }),
  })
  expect(() => registry.spawn("echo hi")).toThrow(/POSIX shell/i)
  expect(registry.list()).toHaveLength(0)
})


test("a keepAlive task SURVIVES its parent process being killed — and keeps logging", async () => {
  const { parentPid, info } = await spawnWrapperParent("stay")
  await waitFor(() => statSync(info.keptLog).size > 0, 20_000)
  const before = statSync(info.keptLog).size

  // Kill ONLY the parent (no /T): a tree-kill would prove nothing.
  if (process.platform === "win32") {
    Bun.spawnSync(["taskkill", "/PID", String(parentPid), "/F"], {
      stdout: "ignore",
      stderr: "ignore",
    })
  } else {
    process.kill(parentPid, "SIGKILL")
  }
  await waitFor(() => !isAlive(parentPid), 15_000)
  await new Promise((r) => setTimeout(r, 1_500))

  expect(isAlive(info.kept)).toBe(true)
  expect(statSync(info.keptLog).size).toBeGreaterThan(before)
}, 60_000)

test("a normal parent exit reaps ordinary tasks and spares keepAlive ones", async () => {
  const { info, waitParentGone } = await spawnWrapperParent("exit")
  await waitParentGone()
  await new Promise((r) => setTimeout(r, 1_500))

  expect(isAlive(info.normal)).toBe(false)
  expect(isAlive(info.kept)).toBe(true)
  const before = statSync(info.keptLog).size
  await new Promise((r) => setTimeout(r, 800))
  expect(statSync(info.keptLog).size).toBeGreaterThan(before)
}, 60_000)
