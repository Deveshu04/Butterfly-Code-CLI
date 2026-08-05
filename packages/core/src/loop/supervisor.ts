import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { PermissionRules } from "../permission/tree"
import type { ProviderPort } from "../provider/port"
import { now, type Usage } from "../session/events"
import { SessionJournal } from "../session/journal"
import { runUserTurn } from "../session/runner"
import type { ToolRegistry } from "../tool/registry"
import { runCommand } from "../tool/shell"
import { type Gate, runGates } from "./gates"
import type { LoopTask, WorkQueue } from "./queue"

export type StopReason = "drained" | "budget" | "max-iterations" | "all-blocked" | "no-progress"

export interface LoopDeps {
  queue: WorkQueue
  provider: ProviderPort
  /** Fresh registry per iteration (isolated tool state). */
  makeRegistry: () => ToolRegistry
  rules: PermissionRules
  model: string
  /** The frozen system prefix for iterations. */
  system: string
  cwd: string
  gates: Gate[]
  /** Total token ceiling for the whole loop. */
  budgetTokens?: number
  maxIterations?: number
  /** Session directory for per-iteration journals. */
  sessionsDir: string
  /** Where handoff.json lives (loop.jsonl sits beside it). */
  handoffPath: string
  smallModel?: string
  onEvent?: (message: string) => void
  /** Commit hook override (tests). Defaults to git add+commit. */
  commit?: (title: string) => Promise<boolean>
}

export interface LoopOutcome {
  stopReason: StopReason
  iterations: number
  closed: number
  blocked: number
  usage: Usage
}

export const DEFAULT_LOOP_ITERATIONS = 25
const ITERATION_MAX_STEPS = 30

interface Handoff {
  updatedAt: string
  lastTask?: string
  lastResult?: "closed" | "failed"
  closed: number
  spentTokens: number
}

function readHandoff(path: string): Handoff | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Handoff
  } catch {
    return undefined
  }
}

function writeHandoff(path: string, handoff: Handoff): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(handoff, null, 2))
}

function logEvent(handoffPath: string, event: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(handoffPath), { recursive: true })
    appendFileSync(
      join(dirname(handoffPath), "loop.jsonl"),
      `${JSON.stringify({ time: now(), ...event })}\n`,
    )
  } catch {
    // the audit log must never break the loop
  }
}

function renderTaskPrompt(task: LoopTask, handoff: Handoff | undefined): string {
  const parts = [`# Task: ${task.title}\n${task.spec}`]
  if (task.lastFailure) {
    parts.push(
      `# Previous attempt failed verification\n${task.lastFailure}\nDiagnose and fix the cause — do not just retry the same change.`,
    )
  }
  if (handoff?.lastTask) {
    parts.push(
      `# Loop context\nPrevious iteration: ${handoff.lastTask} (${handoff.lastResult}). ${handoff.closed} task(s) completed so far. Work ONLY on the task above.`,
    )
  }
  parts.push(
    "When the task is done, stop and summarize. Verification gates run automatically after your turn — do not start unrelated work.",
  )
  return parts.join("\n\n")
}

async function defaultCommit(cwd: string, title: string): Promise<boolean> {
  const message = `loop: ${title}`.replaceAll('"', "'")
  const result = await runCommand(`git add -A && git commit -m "${message}"`, { cwd })
  return result.exitCode === 0
}

export async function runLoop(deps: LoopDeps): Promise<LoopOutcome> {
  const maxIterations = deps.maxIterations ?? DEFAULT_LOOP_ITERATIONS
  const totals: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let iterations = 0
  let closed = 0
  let blocked = 0
  let lastIterationTokens = 0
  let failStreak = 0
  let stopReason: StopReason

  logEvent(deps.handoffPath, { type: "loop.started", model: deps.model })

  for (;;) {
    if (iterations >= maxIterations) {
      stopReason = "max-iterations"
      break
    }
    const spent = totals.input + totals.output
    if (deps.budgetTokens !== undefined && spent + lastIterationTokens > deps.budgetTokens) {
      stopReason = "budget"
      break
    }

    const ready = deps.queue.ready()
    if (ready.length === 0) {
      const counts = deps.queue.counts()
      stopReason =
        counts.blocked > 0 && counts.open === 0 && counts.claimed === 0 ? "all-blocked" : "drained"
      break
    }
    if (failStreak >= 3) {
      stopReason = "no-progress"
      break
    }

    const task = ready[0]
    if (!task || !deps.queue.claim(task.id)) continue
    iterations += 1
    logEvent(deps.handoffPath, { type: "task.claimed", id: task.id, title: task.title })

    const journal = SessionJournal.create(deps.sessionsDir)
    const handoff = readHandoff(deps.handoffPath)
    let turnTokens = 0
    let agentError: string | undefined
    try {
      const outcome = await runUserTurn(
        {
          provider: deps.provider,
          registry: deps.makeRegistry(),
          journal,
          rules: deps.rules,
          model: deps.model,
          system: deps.system,
          cwd: deps.cwd,
          maxSteps: ITERATION_MAX_STEPS,
          ...(deps.budgetTokens !== undefined
            ? { budgetTokens: Math.max(1, deps.budgetTokens - spent) }
            : {}),
          ...(deps.smallModel ? { smallModel: deps.smallModel } : {}),
        },
        renderTaskPrompt(task, handoff),
      )
      totals.input += outcome.usage.input
      totals.output += outcome.usage.output
      totals.cacheRead += outcome.usage.cacheRead
      totals.cacheWrite += outcome.usage.cacheWrite
      turnTokens = outcome.usage.input + outcome.usage.output
    } catch (error) {
      agentError = error instanceof Error ? error.message : String(error)
    }
    lastIterationTokens = turnTokens

    let taskClosed = false
    if (agentError) {
      deps.queue.release(task.id, `agent error: ${agentError}`)
    } else {
      const gateRun = await runGates(deps.gates, deps.cwd)
      for (const result of gateRun.results) {
        logEvent(deps.handoffPath, {
          type: "gate.result",
          task: task.id,
          gate: result.name,
          exitCode: result.exitCode,
        })
      }
      if (gateRun.passed) {
        const committed = deps.commit
          ? await deps.commit(task.title)
          : await defaultCommit(deps.cwd, task.title)
        deps.queue.close(task.id)
        taskClosed = true
        closed += 1
        failStreak = 0
        logEvent(deps.handoffPath, { type: "task.closed", id: task.id, committed })
        deps.onEvent?.(`✓ ${task.title}`)
      } else {
        const failure = gateRun.results
          .map((r) => `[gate ${r.name} exit ${r.exitCode}]\n${r.output}`)
          .join("\n")
          .slice(0, 4_000)
        deps.queue.release(task.id, failure)
        failStreak += 1
        deps.onEvent?.(`✗ ${task.title} (attempt ${task.attempts + 1})`)
      }
    }
    if (deps.queue.get(task.id)?.status === "blocked") {
      blocked += 1
      logEvent(deps.handoffPath, { type: "task.blocked", id: task.id })
    }

    writeHandoff(deps.handoffPath, {
      updatedAt: now(),
      lastTask: task.title,
      lastResult: taskClosed ? "closed" : "failed",
      closed,
      spentTokens: totals.input + totals.output,
    })
  }

  logEvent(deps.handoffPath, { type: "loop.stopped", reason: stopReason, iterations, closed })
  return { stopReason, iterations, closed, blocked, usage: totals }
}
