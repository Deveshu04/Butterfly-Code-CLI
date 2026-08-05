import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext } from "../src/tool/registry"
import { globTool } from "../src/tool/tools/glob"
import { readTool } from "../src/tool/tools/read"
import { TODO_STATE_KEY, todoTool } from "../src/tool/tools/todo"

function ctx(cwd: string, overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd, rules: { "*": "allow" }, state: {}, ...overrides }
}

function fixtureDir(): string {
  return mkdtempSync(join(tmpdir(), "bfly-tools-"))
}

// --- read ---

test("read returns numbered lines", async () => {
  const dir = fixtureDir()
  writeFileSync(join(dir, "a.txt"), "alpha\nbeta\ngamma\n")
  const result = await readTool.execute({ file_path: "a.txt" }, ctx(dir))
  expect(result.isError).toBeFalsy()
  expect(result.output).toContain("1\talpha")
  expect(result.output).toContain("3\tgamma")
})

test("read honors offset and limit and reports the window", async () => {
  const dir = fixtureDir()
  const lines = Array.from({ length: 50 }, (_, i) => `line-${i + 1}`).join("\n")
  writeFileSync(join(dir, "big.txt"), lines)
  const result = await readTool.execute({ file_path: "big.txt", offset: 10, limit: 5 }, ctx(dir))
  expect(result.output).toContain("line-10")
  expect(result.output).toContain("line-14")
  expect(result.output).not.toContain("line-15")
  expect(result.output).toContain("lines 10-14 of 50")
})

test("read of a missing file is an actionable error", async () => {
  const result = await readTool.execute({ file_path: "missing.txt" }, ctx(fixtureDir()))
  expect(result.isError).toBe(true)
  expect(result.output).toContain("missing.txt")
})

// --- glob ---

test("glob finds matching files sorted", async () => {
  const dir = fixtureDir()
  mkdirSync(join(dir, "src"), { recursive: true })
  writeFileSync(join(dir, "src", "b.ts"), "")
  writeFileSync(join(dir, "src", "a.ts"), "")
  writeFileSync(join(dir, "src", "c.md"), "")
  const result = await globTool.execute({ pattern: "src/**/*.ts" }, ctx(dir))
  const lines = result.output.trim().split("\n")
  expect(lines).toEqual(["src/a.ts", "src/b.ts"])
})

test("glob always excludes node_modules", async () => {
  const dir = fixtureDir()
  mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true })
  writeFileSync(join(dir, "node_modules", "pkg", "index.ts"), "")
  writeFileSync(join(dir, "root.ts"), "")
  const result = await globTool.execute({ pattern: "**/*.ts" }, ctx(dir))
  expect(result.output).toContain("root.ts")
  expect(result.output).not.toContain("node_modules")
})

test("glob with no matches says so without erroring", async () => {
  const result = await globTool.execute({ pattern: "**/*.xyz" }, ctx(fixtureDir()))
  expect(result.isError).toBeFalsy()
  expect(result.output).toContain("No files match")
})

// --- todo ---

test("todo replaces the list, renders it, and persists to session state", async () => {
  const context = ctx(fixtureDir())
  const first = await todoTool.execute(
    {
      items: [
        { text: "plan", status: "completed" },
        { text: "build", status: "in_progress" },
      ],
    },
    context,
  )
  expect(first.output).toContain("[x] plan")
  expect(first.output).toContain("[~] build")

  await todoTool.execute({ items: [{ text: "ship", status: "pending" }] }, context)
  const stored = context.state[TODO_STATE_KEY]
  expect(stored).toEqual([{ text: "ship", status: "pending" }])
})
