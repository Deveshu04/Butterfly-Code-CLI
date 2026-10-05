import {
  computeCostUSD,
  type LoopEvent,
  type LoopOutcome,
  type ModelCost,
  type PermissionDecision,
  type PermissionRules,
  type StopReason,
  type TaskStatus,
  type Usage,
} from "@butterfly/core"

/**
 * The `/loop run` live card and its preflight guards (dirty tree, ask rules,
 * spend). Pure state and formatting, no TUI dependency. The reducer folds the
 * same LoopEvent stream the supervisor journals to loop.jsonl.
 */

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

// --- Preflight guards ---

/** How many offending entries a warning lists before eliding the rest. */
const GUARD_LIST_LIMIT = 8

function listSample(items: string[]): string {
  const shown = items.slice(0, GUARD_LIST_LIMIT)
  const rest = items.length - shown.length
  return shown.map((item) => `  ${item}`).join("\n") + (rest > 0 ? `\n  …and ${rest} more` : "")
}

/**
 * `git status --porcelain` lines that make the tree dirty for `/loop run`;
 * same filter as the CLI. `.butterfly/` runtime state is ignored.
 */
export function dirtyLoopLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.slice(3).startsWith(".butterfly/"))
}

/**
 * The loop commits with `git add -A` on every green gate, which would sweep
 * uncommitted work into a loop commit, so a dirty tree is refused by default.
 */
export function dirtyTreeRefusal(lines: string[]): string {
  return [
    `/loop run refused: ${lines.length} uncommitted change(s) in the working tree.`,
    "The loop commits with `git add -A` after every green gate, so these would be swept into a `loop: <task>` commit that isn't yours.",
    listSample(lines),
    "Commit or stash them first — or run `/loop run --allow-dirty` if you really mean to include them.",
  ].join("\n")
}

/** Warning shown when `--allow-dirty` is used; the opt-out is never silent. */
export function dirtyTreeOverride(lines: string[]): string {
  return [
    `--allow-dirty: starting with ${lines.length} uncommitted change(s) — the loop's \`git add -A\` commits WILL be included in them.`,
    listSample(lines),
  ].join("\n")
}

/**
 * Every "ask" reachable in the rules. Loop iterations are unattended, so an
 * ask fails the tool call instead of pausing. Includes the implicit ask when
 * the root `"*"` default is missing or is a pattern map.
 */
export function askBearingRules(rules: PermissionRules): string[] {
  const found: string[] = []
  for (const [tool, entry] of Object.entries(rules)) {
    if (entry === "ask") {
      found.push(tool === "*" ? '"*" (default)' : tool)
    } else if (typeof entry === "object") {
      for (const [pattern, decision] of Object.entries(
        entry as Record<string, PermissionDecision>,
      )) {
        if (decision === "ask") found.push(`${tool}: ${pattern}`)
      }
    }
  }
  if (typeof rules["*"] !== "string") {
    found.push('"*" (no root default — unmatched calls resolve to ask)')
  }
  return found
}

/**
 * Warn and proceed: failing asks trip the no-progress guard, and blocking
 * would make looping impossible for a `{"*":"ask"}` config.
 */
export function askRulesWarning(entries: string[]): string {
  return [
    'warning: your permission rules contain "ask" entries, and loop iterations run UNATTENDED (no approval prompt exists during a loop).',
    'Every ask-classified tool call will FAIL with "no approver available" instead of pausing, so iterations flail until the no-progress guard stops the loop.',
    listSample(entries),
    'Consider a loop-safe set in butterfly.jsonc, e.g. {"*":"allow","edit":{".env*":"deny"}}. Starting anyway — Ctrl+C to stop.',
  ].join("\n")
}

/** `maxSpendUSD` is a per-turn cap and does not bound a loop; say so up front. */
export function spendCapNotice(cap: number): string {
  return `note: maxSpendUSD ($${cap.toFixed(2)}) is a per-turn cap and is not enforced across /loop run — the supervisor takes no cost port. Loop spend is metered live into the session total in the status bar; Ctrl+C stops the loop.`
}

export interface LoopSpendCredit {
  /** New running total of loop dollars already added to the session cost. */
  credited: number
  /** What to add to the session cost right now (0 when nothing is new). */
  delta: number
}

/**
 * LoopEvent usage is cumulative, so credit only the delta since the last
 * event. Monotonic: a snapshot that hasn't grown credits nothing, so feeding
 * the same totals twice is safe.
 */
export function loopSpendCredit(
  usage: Usage,
  cost: ModelCost | undefined,
  alreadyCredited: number,
): LoopSpendCredit {
  if (!cost) return { credited: alreadyCredited, delta: 0 }
  const total = computeCostUSD(usage, cost)
  if (!(total > alreadyCredited)) return { credited: alreadyCredited, delta: 0 }
  return { credited: total, delta: total - alreadyCredited }
}

/** Outcome line shown when the loop stops; matches the CLI's output. */
export function loopSummaryText(outcome: LoopOutcome): string {
  const tokens = outcome.usage.input + outcome.usage.output
  return `loop stopped (${outcome.stopReason}): ${outcome.closed} closed, ${outcome.blocked} blocked, ${outcome.iterations} iteration(s), ${tokens.toLocaleString()} tokens.`
}
