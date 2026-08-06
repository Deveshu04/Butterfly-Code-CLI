import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BG_TASKS_STATE_KEY, type BgTaskRegistry } from "../src/tool/bg-tasks"
import type { ToolContext } from "../src/tool/registry"
import { ToolRegistry } from "../src/tool/registry"
import { resolveShell, runCommand } from "../src/tool/shell"
import { bashTool } from "../src/tool/tools/bash"
import { editTool } from "../src/tool/tools/edit"
import { grepTool, resolveRipgrep } from "../src/tool/tools/grep"

function ctx(cwd: string): ToolContext {
  return { cwd, rules: { "*": "allow" }, state: {} }
}

// Detached background spawns must never leak across tests — kill anything
// still running after each test, keepAlive included.
const liveStates: Record<string, unknown>[] = []
afterEach(() => {
  for (const state of liveStates.splice(0)) {
    const registry = state[BG_TASKS_STATE_KEY] as BgTaskRegistry | undefined
    registry?.reap()
    for (const task of registry?.list() ?? []) {
      if (task.status === "running") registry?.kill(task.id)
    }
  }
})

function fixtureDir(): string {
  return mkdtempSync(join(tmpdir(), "bfly-shell-"))
}


test("resolveShell never picks the WSL bash launcher on Windows", () => {
  const { exe } = resolveShell()
  expect(exe).toBeTruthy()
  if (process.platform === "win32") {
    expect(exe.toLowerCase()).not.toMatch(/system32[\\/]bash\.exe$/)
    if (Bun.which("git")) {
      // With Git for Windows installed, Git Bash must win regardless of
      // whether the parent shell resolved git from cmd\, mingw64\bin or usr\bin.
      expect(exe.toLowerCase()).toEndWith("bash.exe")
    }
  }
})


test("runCommand captures stdout and exit code", async () => {
  const result = await runCommand("echo hello-butterfly", { cwd: fixtureDir() })
  expect(result.stdout).toContain("hello-butterfly")
  expect(result.exitCode).toBe(0)
  expect(result.timedOut).toBe(false)
}, 20_000)

test("runCommand reports non-zero exit codes", async () => {
  const result = await runCommand("exit 3", { cwd: fixtureDir() })
  expect(result.exitCode).toBe(3)
}, 20_000)

test("runCommand kills long commands at the timeout", async () => {
  const start = Date.now()
  const result = await runCommand("sleep 10", { cwd: fixtureDir(), timeoutMs: 1_500 })
  expect(result.timedOut).toBe(true)
  expect(Date.now() - start).toBeLessThan(8_000)
}, 15_000)


test("bash tool reports success output", async () => {
  const result = await bashTool.execute({ command: "echo tool-ok" }, ctx(fixtureDir()))
  expect(result.isError).toBeFalsy()
  expect(result.output).toContain("tool-ok")
}, 20_000)

test("bash tool marks failures as errors and includes the exit code", async () => {
  const result = await bashTool.execute({ command: "nonexistent-cmd-xyz" }, ctx(fixtureDir()))
  expect(result.isError).toBe(true)
  expect(result.output).toMatch(/exit code \d+/)
}, 20_000)

test("bash tool says so when a command produces no output", async () => {
  const result = await bashTool.execute({ command: "true" }, ctx(fixtureDir()))
  expect(result.output).toContain("no output")
}, 20_000)


test("background:true spawns detached — returns fast with a task id + log path, not waiting for the command", async () => {
  const state: Record<string, unknown> = {}
  liveStates.push(state)
  const before = Date.now()
  const result = await bashTool.execute(
    { command: "sleep 5", background: true },
    { cwd: fixtureDir(), rules: { "*": "allow" }, state },
  )
  expect(Date.now() - before).toBeLessThan(1_000)
  expect(result.isError).toBeFalsy()
  const registry = state[BG_TASKS_STATE_KEY] as BgTaskRegistry
  expect(registry).toBeDefined()
  const tasks = registry.list()
  expect(tasks.length).toBe(1)
  expect(result.output).toContain(tasks[0]?.id ?? "")
  expect(result.output).toContain(tasks[0]?.logPath ?? "")
}, 20_000)

test("repeated background calls against the same ctx.state share one registry", async () => {
  const state: Record<string, unknown> = {}
  liveStates.push(state)
  const callCtx: ToolContext = { cwd: fixtureDir(), rules: { "*": "allow" }, state }
  await bashTool.execute({ command: "echo one", background: true }, callCtx)
  await bashTool.execute({ command: "echo two", background: true }, callCtx)
  const registry = state[BG_TASKS_STATE_KEY] as BgTaskRegistry
  expect(registry.list().length).toBe(2)
}, 20_000)

test("background bash goes through the SAME permission gate as foreground bash", async () => {
  const registry = new ToolRegistry()
  registry.register(bashTool)
  const state: Record<string, unknown> = {}
  liveStates.push(state)
  const result = await registry.run(
    "bash",
    { command: "echo nope", background: true },
    { cwd: fixtureDir(), rules: { bash: "deny" }, state },
  )
  expect(result.isError).toBe(true)
  expect(result.output).toContain("Permission denied")
  expect(state[BG_TASKS_STATE_KEY]).toBeUndefined()
})

test("background bash without a pre-seeded registry still works (lazy, no journal)", async () => {
  const state: Record<string, unknown> = {}
  liveStates.push(state)
  const result = await bashTool.execute(
    { command: "echo lazy", background: true },
    { cwd: fixtureDir(), rules: { "*": "allow" }, state },
  )
  expect(result.isError).toBeFalsy()
  expect(state[BG_TASKS_STATE_KEY]).toBeDefined()
})


test("resolveRipgrep finds an rg binary", async () => {
  const rg = await resolveRipgrep()
  expect(rg.toLowerCase()).toContain("rg")
})

test("grep finds matches as path:line:text", async () => {
  const dir = fixtureDir()
  mkdirSync(join(dir, "src"), { recursive: true })
  writeFileSync(join(dir, "src", "a.ts"), "const alpha = 1\nconst needle_xyz = 2\n")
  writeFileSync(join(dir, "src", "b.md"), "needle_xyz in markdown\n")
  const result = await grepTool.execute({ pattern: "needle_xyz", glob: "*.ts" }, ctx(dir))
  expect(result.isError).toBeFalsy()
  expect(result.output).toContain("a.ts")
  expect(result.output).toContain(":2:")
  expect(result.output).not.toContain("b.md")
})

test("grep reports no matches without erroring", async () => {
  const result = await grepTool.execute({ pattern: "zzz_never_there" }, ctx(fixtureDir()))
  expect(result.isError).toBeFalsy()
  expect(result.output).toContain("No matches")
})


test("edit replaces text and persists to disk", async () => {
  const dir = fixtureDir()
  writeFileSync(join(dir, "note.md"), "version: 1\n")
  const result = await editTool.execute(
    { file_path: "note.md", old_string: "version: 1", new_string: "version: 2" },
    ctx(dir),
  )
  expect(result.isError).toBeFalsy()
  expect(readFileSync(join(dir, "note.md"), "utf8")).toBe("version: 2\n")
  // UI-only diff meta (never sent to the model).
  const meta = result.meta as { diff?: string; path?: string } | undefined
  expect(meta?.path).toBe("note.md")
  expect(meta?.diff).toContain("-version: 1")
  expect(meta?.diff).toContain("+version: 2")
})

test("edit creates a new file when old_string is empty", async () => {
  const dir = fixtureDir()
  const result = await editTool.execute(
    { file_path: "new/deep/file.txt", old_string: "", new_string: "created\n" },
    ctx(dir),
  )
  expect(result.isError).toBeFalsy()
  expect(readFileSync(join(dir, "new", "deep", "file.txt"), "utf8")).toBe("created\n")
})

test("edit on a missing file explains how to create one", async () => {
  const result = await editTool.execute(
    { file_path: "ghost.ts", old_string: "x", new_string: "y" },
    ctx(fixtureDir()),
  )
  expect(result.isError).toBe(true)
  expect(result.output).toContain("empty old_string")
})

test("edit rejects a TS edit that breaks syntax and leaves the file intact", async () => {
  const dir = fixtureDir()
  const original = "export function f() {\n  return 1\n}\n"
  writeFileSync(join(dir, "code.ts"), original)
  const result = await editTool.execute(
    { file_path: "code.ts", old_string: "return 1\n}", new_string: "return (1\n}" },
    ctx(dir),
  )
  expect(result.isError).toBe(true)
  expect(result.output.toLowerCase()).toContain("syntax")
  expect(readFileSync(join(dir, "code.ts"), "utf8")).toBe(original)
})

test("edit does not syntax-gate non-code files", async () => {
  const dir = fixtureDir()
  writeFileSync(join(dir, "doc.md"), "some ( unbalanced { text\n")
  const result = await editTool.execute(
    { file_path: "doc.md", old_string: "unbalanced", new_string: "still ( unbalanced" },
    ctx(dir),
  )
  expect(result.isError).toBeFalsy()
})
