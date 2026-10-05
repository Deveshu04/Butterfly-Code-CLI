import { expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { killCommand, runCommand } from "../src/tool/shell"
import { bashTool } from "../src/tool/tools/bash"

/**
 * Live shells: output streams to the UI while a command runs, one command can
 * be stopped on its own, and a stop or timeout ends the whole process tree.
 */

test("killCommand stops a compound command at once, children included", async () => {
  const started = Date.now()
  const run = runCommand("echo start; sleep 30; echo end", { cwd: tmpdir(), id: "live-1" })
  await new Promise((resolve) => setTimeout(resolve, 400))
  expect(killCommand("live-1")).toBe(true)
  const result = await run
  expect(Date.now() - started).toBeLessThan(10_000)
  expect(result.killed).toBe(true)
  expect(result.stdout).toContain("start")
  expect(result.stdout).not.toContain("end")
  expect(killCommand("live-1")).toBe(false) // no longer registered
})

test("a timeout also takes the whole tree down promptly", async () => {
  const started = Date.now()
  const result = await runCommand("sleep 30; echo late", { cwd: tmpdir(), timeoutMs: 500 })
  expect(result.timedOut).toBe(true)
  expect(Date.now() - started).toBeLessThan(10_000)
})

test("an aborted signal stops the command", async () => {
  const controller = new AbortController()
  const run = runCommand("sleep 30", { cwd: tmpdir(), signal: controller.signal })
  setTimeout(() => controller.abort(), 300)
  const result = await run
  expect(result.killed).toBe(true)
})

test("output streams through onOutput as it arrives", async () => {
  const seen: string[] = []
  const result = await runCommand("echo one; sleep 0.3; echo two 1>&2", {
    cwd: tmpdir(),
    onOutput: (text) => seen.push(text),
  })
  expect(result.exitCode).toBe(0)
  expect(seen.join("")).toContain("one")
  expect(seen.join("")).toContain("two")
})

test("the bash tool reports live output and tells the model about a user stop", async () => {
  const progress: string[] = []
  const run = bashTool.execute(
    { command: "echo working; sleep 30" },
    {
      cwd: tmpdir(),
      rules: { "*": "allow" },
      state: {},
      callId: "live-tool",
      progress: (text) => progress.push(text),
    },
  )
  await new Promise((resolve) => setTimeout(resolve, 700))
  expect(progress.at(-1)).toContain("working")
  killCommand("live-tool")
  const outcome = await run
  expect(outcome.isError).toBe(true)
  expect(outcome.output).toContain("stopped by the user")
})

// A child that escapes the kill (here via setsid; on Windows a Git Bash child
// can survive the tree kill) must not keep runCommand waiting on its pipes.
const hasSetsid = Bun.which("setsid") !== null

test.skipIf(!hasSetsid)(
  "a stopped command returns even if an escaped child holds its output",
  async () => {
    const started = Date.now()
    const run = runCommand("echo start; (setsid sleep 30 &); sleep 30", {
      cwd: tmpdir(),
      id: "live-escape",
    })
    await new Promise((resolve) => setTimeout(resolve, 400))
    killCommand("live-escape")
    const result = await run
    expect(Date.now() - started).toBeLessThan(4_000)
    expect(result.killed).toBe(true)
    expect(result.stdout).toContain("start")
  },
)

test.skipIf(!hasSetsid)("a finished command is not held open by a background child", async () => {
  const started = Date.now()
  const result = await runCommand("echo done; (setsid sleep 30 &)", { cwd: tmpdir() })
  expect(Date.now() - started).toBeLessThan(4_000)
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain("done")
})
