import type { JournalHeader, SessionEvent, Usage } from "./events"

export interface ProjectedState {
  sessionId: string
  cwd: string
  title?: string
  /**
   * The effective timeline after folding compaction (events before the cut
   * are replaced by the summary) and pruning (evicted tool outputs redacted).
   * Meta events (tool.pruned) are consumed, not carried.
   */
  timeline: SessionEvent[]
  usage: Usage
  turns: number
}

export const PRUNED_PLACEHOLDER = "[output pruned: superseded by newer context]"

export interface TimelineEntry {
  /** Original event index in the journal — compaction cuts reference these. */
  index: number
  event: SessionEvent
}

/**
 * Fold raw journal events into the effective timeline: compaction replaces
 * the cut prefix with its summary, a rewind re-folds the raw prefix, and
 * tool.pruned events fill the pruned set. Outputs are not redacted here,
 * since planners need real sizes; project() redacts for rendering.
 */
export function foldTimeline(events: SessionEvent[]): {
  entries: TimelineEntry[]
  pruned: Set<string>
} {
  return foldPrefix(events, events.length, new Map())
}

type Fold = { entries: TimelineEntry[]; pruned: Set<string> }

/**
 * Fold of `events[0, length)`, memoized per top-level call. Each rewind
 * re-folds its prefix, which contains earlier rewinds, so without the cache
 * stacked rewinds cost exponential time. Cached arrays are never mutated.
 */
function foldPrefix(events: SessionEvent[], length: number, cache: Map<number, Fold>): Fold {
  const cached = cache.get(length)
  if (cached) return cached
  const pruned = new Set<string>()
  let entries: TimelineEntry[] = []

  events.slice(0, length).forEach((event, index) => {
    switch (event.type) {
      case "session.compacted": {
        // Keep AGENTS.md fragments from the cut region: reconcile dedups on
        // the raw journal and would never re-offer them.
        const survivingFragments = entries.filter(
          (entry) => entry.index < event.keepFromIndex && entry.event.type === "context.fragment",
        )
        entries = [
          ...survivingFragments,
          { index, event },
          ...entries.filter((entry) => entry.index >= event.keepFromIndex),
        ]
        break
      }
      case "tool.pruned":
        for (const id of event.callIds) pruned.add(id)
        break
      case "session.rewound": {
        // Re-fold the raw prefix rather than filtering the folded list:
        // compaction replaces the prefix with one late-indexed summary, so a
        // filter would drop everything. Re-folding also un-compacts when
        // rewinding past a compaction. The cut is always before this event,
        // so recursion terminates.
        const cut = Math.min(event.toIndex, index)
        // AGENTS.md fragments survive, as with compaction.
        const survivingFragments = entries.filter(
          (entry) => entry.index >= cut && entry.event.type === "context.fragment",
        )
        entries = [...foldPrefix(events, cut, cache).entries, ...survivingFragments]
        break
      }
      // Bookkeeping events, never part of the model timeline.
      case "turn.snapshot":
        break
      case "hook.run":
        break
      case "session.handoff":
        break
      case "bgtask.start":
      case "bgtask.end":
        break
      default:
        entries.push({ index, event })
    }
  })

  const result = { entries, pruned }
  cache.set(length, result)
  return result
}

/**
 * Safe `session.rewound` target for a checkpoint. Per-call snapshots sit
 * after their step's tool.call batch, so rewinding there would leave calls
 * without results; walk back to the step's message.assistant instead.
 */
export function safeRewindIndex(events: SessionEvent[], checkpointIndex: number): number {
  const checkpoint = events[checkpointIndex]
  if (checkpoint?.type !== "turn.snapshot" || checkpoint.callId === undefined) {
    return checkpointIndex
  }
  for (let i = checkpointIndex - 1; i >= 0; i--) {
    if (events[i]?.type === "message.assistant") return i
  }
  return checkpointIndex
}

export function project(header: JournalHeader, events: SessionEvent[]): ProjectedState {
  let cwd = ""
  let title: string | undefined
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let turns = 0

  for (const event of events) {
    switch (event.type) {
      case "session.created":
        cwd = event.cwd
        if (event.title) title = event.title
        break
      case "session.title":
        title = event.title
        break
      case "turn.completed":
        turns += 1
        usage.input += event.usage.input
        usage.output += event.usage.output
        usage.cacheRead += event.usage.cacheRead
        usage.cacheWrite += event.usage.cacheWrite
        break
      default:
        break
    }
  }

  const { entries, pruned } = foldTimeline(events)
  const timeline = entries.map(({ event }) => {
    if (event.type === "tool.result" && pruned.has(event.callId)) {
      return { ...event, output: PRUNED_PLACEHOLDER }
    }
    return event
  })

  return { sessionId: header.sessionId, cwd, title, timeline, usage, turns }
}
