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

export function foldTimeline(events: SessionEvent[]): {
  entries: TimelineEntry[]
  pruned: Set<string>
} {
  const pruned = new Set<string>()
  let entries: TimelineEntry[] = []

  events.forEach((event, index) => {
    switch (event.type) {
      case "session.compacted": {
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
      case "session.rewound":
        entries = entries.filter((entry) => entry.index < event.toIndex)
        break
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

  return { entries, pruned }
}

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
