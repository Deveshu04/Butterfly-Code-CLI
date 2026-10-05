import { estimateTokens } from "../context/tokens"
import type { SessionEvent } from "./events"
import { foldTimeline } from "./projector"
import { latestTodoResultId } from "./todo-state"

export interface PruneOptions {
  /** Tool outputs older than this recency window (est. tokens) are eligible. */
  windowTokens?: number
  /** Outputs smaller than this are never worth pruning. */
  minChars?: number
}

export const DEFAULT_PRUNE_WINDOW_TOKENS = 40_000
export const DEFAULT_PRUNE_MIN_CHARS = 500

/**
 * Tier-1 pruning: pick tool outputs that fell out of the recency window. The
 * caller journals one tool.pruned event and the projector redacts them; the
 * journal keeps the full output.
 */
export function planPrune(events: SessionEvent[], opts?: PruneOptions): string[] {
  const windowTokens = opts?.windowTokens ?? DEFAULT_PRUNE_WINDOW_TOKENS
  const minChars = opts?.minChars ?? DEFAULT_PRUNE_MIN_CHARS
  const { entries, pruned } = foldTimeline(events)
  // Never evict the result that defines the current todo list.
  const plan = latestTodoResultId(entries.map((entry) => entry.event))

  const victims: string[] = []
  let tokensNewerThanEntry = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (!entry) continue
    const { event } = entry
    const outsideWindow = tokensNewerThanEntry > windowTokens
    if (
      event.type === "tool.result" &&
      outsideWindow &&
      !pruned.has(event.callId) &&
      event.callId !== plan &&
      event.output.length >= minChars
    ) {
      victims.push(event.callId)
    }
    tokensNewerThanEntry += estimateTokens(JSON.stringify(event))
  }
  return victims.reverse()
}
