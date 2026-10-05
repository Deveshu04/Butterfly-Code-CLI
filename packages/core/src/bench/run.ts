import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { PermissionRules } from "../permission/tree"
import type { ProviderPort } from "../provider/port"
import { SessionJournal } from "../session/journal"
import { runUserTurn } from "../session/runner"
import type { ToolRegistry } from "../tool/registry"
import { runCommand } from "../tool/shell"
import { extractSessionMetrics, type SessionMetrics } from "./metrics"

/**
 * Benchmark harness: each task gets a fresh fixture dir and one agent turn;
 * a check command decides solved/failed, the rest is read off the journal.
 */

export interface BenchTask {
  id: string
  /** Fixture files written before the run (path → content). */
  files?: Record<string, string>
  task: string
  /** Exit-0 command that defines success, run in the fixture dir. */
  check: string
}

export interface BenchTaskResult {
  id: string
  solved: boolean
  metrics: SessionMetrics
  checkOutput: string
  fixtureDir: string
  /** False when the fixture was deleted after scoring (the default). */
  kept: boolean
}

export interface BenchDeps {
  provider: ProviderPort
  makeRegistry: () => ToolRegistry
  model: string
  buildSystem: (cwd: string) => string
  rules?: PermissionRules
  maxSteps?: number
  budgetTokens?: number
  onEvent?: (message: string) => void
  /** Keep each task's fixture directory after scoring (CLI --keep). */
  keepFixtures?: boolean
}

export async function runBenchTask(task: BenchTask, deps: BenchDeps): Promise<BenchTaskResult> {
  // One parent for everything butterfly puts in temp, never loose bfly-* dirs.
  const parent = join(tmpdir(), "butterfly", "bench")
  mkdirSync(parent, { recursive: true })
  const fixtureDir = mkdtempSync(join(parent, `${task.id.replace(/[^A-Za-z0-9_-]/g, "_")}-`))
  for (const [path, content] of Object.entries(task.files ?? {})) {
    const absolute = join(fixtureDir, path)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content)
  }

  const journal = SessionJournal.create(join(fixtureDir, ".butterfly", "sessions"))
  let agentError: string | undefined
  try {
    await runUserTurn(
      {
        provider: deps.provider,
        registry: deps.makeRegistry(),
        journal,
        rules: deps.rules ?? { "*": "allow" },
        model: deps.model,
        system: deps.buildSystem(fixtureDir),
        cwd: fixtureDir,
        maxSteps: deps.maxSteps ?? 15,
        ...(deps.budgetTokens !== undefined ? { budgetTokens: deps.budgetTokens } : {}),
      },
      task.task,
    )
  } catch (error) {
    agentError = error instanceof Error ? error.message : String(error)
  }

  const check = await runCommand(task.check, { cwd: fixtureDir, timeoutMs: 120_000 })
  const metrics = extractSessionMetrics(journal.path)
  if (!deps.keepFixtures) rmSync(fixtureDir, { recursive: true, force: true, maxRetries: 2 })
  return {
    id: task.id,
    solved: !agentError && check.exitCode === 0,
    metrics,
    checkOutput: agentError ?? `${check.stdout}${check.stderr}`.trim(),
    fixtureDir,
    kept: deps.keepFixtures === true,
  }
}

export interface BenchSummary {
  results: BenchTaskResult[]
  solved: number
  total: number
  totalInputTokens: number
  totalOutputTokens: number
  /** Input tokens per solved task. */
  inputTokensPerSolved: number | null
  malformedEditRate: number | null
}

export async function runBenchSuite(tasks: BenchTask[], deps: BenchDeps): Promise<BenchSummary> {
  const results: BenchTaskResult[] = []
  for (const task of tasks) {
    deps.onEvent?.(`[bench] ${task.id}…`)
    const result = await runBenchTask(task, deps)
    deps.onEvent?.(`[bench] ${task.id}: ${result.solved ? "solved" : "FAILED"}`)
    results.push(result)
  }

  const solved = results.filter((r) => r.solved).length
  const totalInput = results.reduce((sum, r) => sum + r.metrics.usage.input, 0)
  const totalOutput = results.reduce((sum, r) => sum + r.metrics.usage.output, 0)
  const editCalls = results.reduce((sum, r) => sum + r.metrics.editCalls, 0)
  const malformed = results.reduce((sum, r) => sum + r.metrics.malformedEdits, 0)

  return {
    results,
    solved,
    total: tasks.length,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    inputTokensPerSolved: solved > 0 ? Math.round(totalInput / solved) : null,
    malformedEditRate: editCalls > 0 ? malformed / editCalls : null,
  }
}

/** Built-in mini-suite: exercises create, edit-with-context, and bug-fixing. */
export const DEFAULT_SUITE: BenchTask[] = [
  {
    id: "create-file",
    task: "Create a file named VERSION.txt containing exactly the text 1.2.3",
    check: "grep -q '1.2.3' VERSION.txt",
  },
  {
    id: "fix-off-by-one",
    files: {
      "math.ts":
        "export function sumTo(n: number): number {\n  let total = 0\n  for (let i = 1; i < n; i++) total += i\n  return total\n}\n",
    },
    task: "sumTo(n) should return the sum of 1..n inclusive, but sumTo(3) currently returns 3 instead of 6. Fix the bug in math.ts.",
    check: `bun -e "import { sumTo } from './math.ts'; if (sumTo(3) !== 6 || sumTo(1) !== 1) process.exit(1)"`,
  },
  {
    id: "add-function",
    files: {
      "util.ts": "export function half(n: number): number {\n  return n / 2\n}\n",
    },
    task: "Add an exported function double(n: number): number to util.ts that returns n * 2. Keep the existing code.",
    check: `bun -e "import { double, half } from './util.ts'; if (double(4) !== 8 || half(4) !== 2) process.exit(1)"`,
  },
]
