#!/usr/bin/env bun
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")
const DEFAULT_EXE = join(ROOT, "dist", process.platform === "win32" ? "butterfly.exe" : "butterfly")
const EXE = process.argv[2] ?? DEFAULT_EXE

let failures = 0

function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`ok - ${message}`)
  } else {
    failures++
    console.error(`FAIL - ${message}`)
  }
}

function runExe(args: string[], cwd: string): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync([EXE, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  })
  return {
    exitCode: proc.exitCode ?? 1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  }
}

console.log(`smoke-exe: target = ${EXE}\n`)

{
  const result = runExe(["--help"], ROOT)
  check(result.exitCode === 0, `--help exits 0 (got ${result.exitCode})`)
  check(result.stdout.includes("butterfly"), "--help prints the usage banner")
  if (result.exitCode !== 0) console.error(result.stderr)
}

{
  const fixture = mkdtempSync(join(tmpdir(), "bfly-exe-smoke-"))
  mkdirSync(join(fixture, "src"), { recursive: true })
  writeFileSync(
    join(fixture, "src", "sample.ts"),
    [
      "export function greet(name: string): string {",
      '  return "hi " + name',
      "}",
      "",
      "export function callGreet(): string {",
      '  return greet("world")',
      "}",
      "",
    ].join("\n"),
  )

  const result = runExe(
    ["run", "say hello", "--model", "mock/mock", "--cwd", fixture, "--json"],
    fixture,
  )
  check(result.exitCode === 0, `headless run with mock provider exits 0 (got ${result.exitCode})`)
  if (result.exitCode !== 0) {
    console.error("--- stdout ---\n" + result.stdout)
    console.error("--- stderr ---\n" + result.stderr)
  }

  const dbPath = join(fixture, ".butterfly", "graph.db")
  try {
    const db = new Database(dbPath)
    const row = db.query("SELECT COUNT(*) as c FROM symbols").get() as { c: number } | null
    db.close()
    check((row?.c ?? 0) > 0, `graph sync populated symbols in ${dbPath} (found ${row?.c ?? 0})`)
  } catch (error) {
    check(false, `graph.db readable at ${dbPath} (${error instanceof Error ? error.message : error})`)
  }
}

console.log("")
if (failures > 0) {
  console.error(`smoke-exe: ${failures} check(s) FAILED`)
  process.exit(1)
}
console.log("smoke-exe: all checks passed")
