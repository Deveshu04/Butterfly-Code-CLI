import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runDoctorCommand } from "../src/doctor"

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Recursive file listing (relative paths, sorted) — for before/after no-write snapshots. */
function listAllFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string, rel: string) => {
    let entries: import("node:fs").Dirent[]
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(join(d, entry.name), relPath)
      else out.push(relPath)
    }
  }
  walk(dir, "")
  return out.sort()
}

function captureLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = []
  const original = console.log
  console.log = (line: string) => logs.push(line)
  return { logs, restore: () => (console.log = original) }
}

test("butterfly doctor is strictly read-only: a fresh checkout gets zero new files or directories", async () => {
  const cwd = tempDir("bfly-doctor-fresh-cwd-")
  const home = tempDir("bfly-doctor-fresh-home-")
  const before = { cwd: listAllFiles(cwd), home: listAllFiles(home) }
  expect(before.cwd).toEqual([])
  expect(before.home).toEqual([])

  const cap = captureLog()
  let code: number
  try {
    code = await runDoctorCommand(["--json", "--cwd", cwd, "--home", home])
  } finally {
    cap.restore()
  }

  expect(listAllFiles(cwd)).toEqual([])
  expect(listAllFiles(home)).toEqual([])
  expect(existsSync(join(cwd, ".butterfly"))).toBe(false)
  expect(existsSync(join(home, ".config"))).toBe(false)
  expect(code).toBe(0)

  const report = JSON.parse(cap.logs[0] ?? "")
  expect(report.prefix.graphAvailable).toBe(false)
  expect(report.mcp).toEqual([])
  expect(report.mcpConfigured).toEqual([])
}, 20_000)

test("butterfly doctor never connects configured MCP servers — reports them as unverified instead", async () => {
  const cwd = tempDir("bfly-doctor-mcp-cwd-")
  const home = tempDir("bfly-doctor-mcp-home-")
  mkdirSync(join(cwd, ".butterfly"), { recursive: true })
  writeFileSync(
    join(cwd, ".butterfly", "butterfly.jsonc"),
    `{ "mcp": { "docs": { "command": "definitely-not-a-real-binary-xyz123" } } }`,
  )

  const cap = captureLog()
  try {
    await runDoctorCommand(["--json", "--cwd", cwd, "--home", home])
  } finally {
    cap.restore()
  }

  const report = JSON.parse(cap.logs[0] ?? "")
  expect(report.mcp).toEqual([])
  expect(report.mcpConfigured).toEqual(["docs"])
  // No trace of an attempted spawn/connection anywhere on disk either.
  expect(existsSync(join(cwd, ".butterfly", "index.db"))).toBe(false)
}, 20_000)

test("butterfly doctor --json emits exactly one valid JSON report", async () => {
  const cwd = tempDir("bfly-doctor-cwd-")
  const home = tempDir("bfly-doctor-home-")
  mkdirSync(join(cwd, ".butterfly"), { recursive: true })
  writeFileSync(
    join(cwd, ".butterfly", "butterfly.jsonc"),
    `{ "model": "ollama/qwen3:8b", "bogusTopLevelKey": true }`,
  )

  const cap = captureLog()
  let code: number
  try {
    code = await runDoctorCommand(["--json", "--cwd", cwd, "--home", home])
  } finally {
    cap.restore()
  }

  expect(cap.logs.length).toBe(1)
  const report = JSON.parse(cap.logs[0] ?? "")
  expect(report.prefix).toBeDefined()
  expect(typeof report.prefix.systemTokens).toBe("number")
  expect(report.journal).toBeDefined()
  expect(Array.isArray(report.mcp)).toBe(true)
  expect(Array.isArray(report.configLint)).toBe(true)
  expect(
    report.configLint.some(
      (issue: { kind: string; message: string }) =>
        issue.kind === "unknown-key" && issue.message.includes("bogusTopLevelKey"),
    ),
  ).toBe(true)
  // No prior cache in this fresh home — the catalog-miss note should fire
  // instead of a misleading per-model "unknown-model" false positive.
  expect(
    report.configLint.some(
      (issue: { kind: string; message: string }) =>
        issue.kind === "catalog-stale" && issue.message.includes("no local models.dev cache"),
    ),
  ).toBe(true)
  expect(code).toBe(1) // lint issues found
}, 20_000)

test("a clean config with no session yet exits 0 and prints readable text", async () => {
  const cwd = tempDir("bfly-doctor-cwd-")
  const home = tempDir("bfly-doctor-home-")

  const cap = captureLog()
  let code: number
  try {
    code = await runDoctorCommand(["--cwd", cwd, "--home", home])
  } finally {
    cap.restore()
  }

  expect(code).toBe(0)
  const text = cap.logs.join("\n")
  expect(text).toContain("prefix breakdown")
  expect(text).toContain("no session yet")
  expect(text).toContain("graph skeleton  not initialized")
  expect(text).toContain("config lint: clean")
}, 20_000)
