import type { LoopEvent, LoopOutcome, StopReason, TaskStatus, Usage } from "@butterfly/core"


export interface LoopCardState {
  model?: string
  iteration: number
  counts: Record<TaskStatus, number>
  usage: Usage
  currentTask?: string
  lastGate?: { name: string; exitCode: number }
  stopReason?: StopReason
}

export const INITIAL_LOOP_CARD: LoopCardState = {
  iteration: 0,
  counts: { open: 0, claimed: 0, closed: 0, blocked: 0 },
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}

export function applyLoopEvent(state: LoopCardState, event: LoopEvent): LoopCardState {
  switch (event.type) {
    case "loop.started":
      return { ...state, model: event.model }
    case "task.claimed":
      return {
        ...state,
        currentTask: event.title,
        iteration: event.progress.iterations,
        counts: event.progress.counts,
        usage: event.progress.usage,
      }
    case "gate.result":
      return { ...state, lastGate: { name: event.gate, exitCode: event.exitCode } }
    case "task.closed":
    case "task.failed":
    case "task.blocked":
      return {
        ...state,
        iteration: event.progress.iterations,
        counts: event.progress.counts,
        usage: event.progress.usage,
      }
    case "loop.stopped":
      return {
        ...state,
        stopReason: event.reason,
        iteration: event.progress.iterations,
        counts: event.progress.counts,
        usage: event.progress.usage,
      }
    default:
      return state
  }
}

function fmtCounts(counts: Record<TaskStatus, number>): string {
  return `ready ${counts.open}  ·  claimed ${counts.claimed}  ·  done ${counts.closed}  ·  blocked ${counts.blocked}`
}

/** One-line live summary rendered inside the loop card while it runs. */
export function loopCardText(state: LoopCardState): string {
  const parts = [`iteration ${state.iteration}`, fmtCounts(state.counts)]
  if (state.currentTask) parts.push(`task: ${state.currentTask}`)
  if (state.lastGate) {
    parts.push(
      `gate ${state.lastGate.name}: ${state.lastGate.exitCode === 0 ? "pass" : `exit ${state.lastGate.exitCode}`}`,
    )
  }
  const tokens = state.usage.input + state.usage.output
  if (tokens > 0) parts.push(`${tokens.toLocaleString()} tok`)
  return parts.join("  ·  ")
}

export function loopSummaryText(outcome: LoopOutcome): string {
  const tokens = outcome.usage.input + outcome.usage.output
  return `loop stopped (${outcome.stopReason}): ${outcome.closed} closed, ${outcome.blocked} blocked, ${outcome.iterations} iteration(s), ${tokens.toLocaleString()} tokens.`
}
