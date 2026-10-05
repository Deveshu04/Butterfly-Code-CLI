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
import type { LoopTask, TaskStatus, WorkQueue } from "./queue"

export type StopReason =
  | "drained"
  | "budget"
  | "max-iterations"
  | "all-blocked"
  | "no-progress"
  | "interrupted"

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
  /** Step-level provider retry cap per iteration; defaults to the runner's 3. */
  retries?: number
  /** Live progress: the same events written to loop.jsonl. */
  onEvent?: (event: LoopEvent) => void
  /** Interrupt, checked between iterations and passed to each turn. A task
   * claimed when it fires stays claimed until the next `loop run`. */
  signal?: AbortSignal
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

/** Queue snapshot attached to most LoopEvents (one cheap query), so callers
 * never fold deltas. */
export interface LoopProgress {
  counts: Record<TaskStatus, number>
  usage: Usage
  iterations: number
}

/** Live progress events, mirroring what logEvent() writes to loop.jsonl. */
export type LoopEvent =
  | { type: "loop.started"; model: string }
  | { type: "task.claimed"; id: string; title: string; progress: LoopProgress }
  | { type: "gate.result"; task: string; gate: string; exitCode: number }
  | { type: "task.closed"; id: string; title: string; committed: boolean; progress: LoopProgress }
  | { type: "task.failed"; id: string; title: string; attempts: number; progress: LoopProgress }
  | { type: "task.blocked"; id: string; title: string; progress: LoopProgress }
  | { type: "loop.stopped"; reason: StopReason; progress: LoopProgress }

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

/**
 * The LLM-free supervisor: claims one ready task per iteration, runs it in a
 * fresh context primed with handoff + task spec, gates serially, commits on
 * green, and requeues with feedback or blocks on red. Stops on a drained
 * queue, budget (predictive), max iterations, or no progress.
 */
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
  deps.onEvent?.({ type: "loop.started", model: deps.model })
  const progress = (): LoopProgress => ({
    counts: deps.queue.counts(),
    usage: totals,
    iterations,
  })

  for (;;) {
    if (deps.signal?.aborted) {
      stopReason = "interrupted"
      break
    }
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
    deps.onEvent?.({ type: "task.claimed", id: task.id, title: task.title, progress: progress() })

    // Fresh context per iteration.
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
          ...(deps.retries !== undefined ? { retries: deps.retries } : {}),
          signal: deps.signal,
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

    if (deps.signal?.aborted) {
      // Leave the task "claimed" so the stale-claim reset picks it up later.
      stopReason = "interrupted"
      break
    }

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
        deps.onEvent?.({
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
        deps.onEvent?.({
          type: "task.closed",
          id: task.id,
          title: task.title,
          committed,
          progress: progress(),
        })
      } else {
        const failure = gateRun.results
          .map((r) => `[gate ${r.name} exit ${r.exitCode}]\n${r.output}`)
          .join("\n")
          .slice(0, 4_000)
        deps.queue.release(task.id, failure)
        failStreak += 1
        const attempts = task.attempts + 1
        logEvent(deps.handoffPath, { type: "task.failed", id: task.id, attempts })
        deps.onEvent?.({
          type: "task.failed",
          id: task.id,
          title: task.title,
          attempts,
          progress: progress(),
        })
      }
    }
    if (deps.queue.get(task.id)?.status === "blocked") {
      blocked += 1
      logEvent(deps.handoffPath, { type: "task.blocked", id: task.id })
      deps.onEvent?.({ type: "task.blocked", id: task.id, title: task.title, progress: progress() })
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
  deps.onEvent?.({ type: "loop.stopped", reason: stopReason, progress: progress() })
  return { stopReason, iterations, closed, blocked, usage: totals }
}
