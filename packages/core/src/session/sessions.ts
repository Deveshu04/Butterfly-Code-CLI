import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import type { SessionEvent } from "./events"
import { SessionJournal } from "./journal"

/** Session discovery and transcript export, as pure folds over journals. */

export interface SessionSummary {
  id: string
  path: string
  /** mtime epoch ms — listing is newest first. */
  modified: number
  /** First user message, trimmed for display. */
  title: string
  turns: number
}

export function listSessions(dir: string, limit = 20): SessionSummary[] {
  let files: string[]
  try {
    files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"))
  } catch {
    return []
  }

  const summaries: SessionSummary[] = []
  for (const name of files) {
    const path = join(dir, name)
    try {
      const { header, events } = SessionJournal.replay(path)
      const firstUser = events.find((event) => event.type === "message.user")
      const title =
        firstUser && "text" in firstUser
          ? firstUser.text.replace(/\s+/g, " ").slice(0, 60)
          : "(empty session)"
      summaries.push({
        id: header.sessionId,
        path,
        modified: statSync(path).mtimeMs,
        title,
        turns: events.filter((event) => event.type === "turn.completed").length,
      })
    } catch {
      // corrupt or foreign file — skip, never break the listing
    }
  }
  return summaries.sort((a, b) => b.modified - a.modified).slice(0, limit)
}

/** Fork a session: a new journal with a new id and identical history. */
export function forkSession(journalPath: string, dir: string): string {
  const { header, events } = SessionJournal.replay(journalPath)
  const forked = SessionJournal.create(dir)
  for (const event of events) forked.append(event)
  void header
  return forked.path
}

/** Live user-prompt heading. The pager matches this prefix for prompt jumps. */
const PROMPT_HEADING = "## ❯ "
/**
 * Heading for undone prompts: labels every undone turn and keeps them out of
 * the pager's prompt-jump targets.
 */
const UNDONE_PROMPT_HEADING = "## (undone) ❯ "
const UNDONE_OPEN = "> _undone — /undo rewound the following out of the conversation:_"
const UNDONE_CLOSE = "> _end of undone_"

/**
 * Indices of events removed by a `session.rewound`: one at index R with
 * `toIndex` T removes [T, R). Overlapping rewinds union.
 */
function undoneIndices(events: SessionEvent[]): Set<number> {
  const undone = new Set<number>()
  events.forEach((event, index) => {
    if (event.type !== "session.rewound") return
    for (let i = Math.max(0, event.toIndex); i < index; i++) undone.add(i)
  })
  return undone
}

function renderEvent(event: SessionEvent, undone: boolean): string[] {
  switch (event.type) {
    case "message.user":
      return [`${undone ? UNDONE_PROMPT_HEADING : PROMPT_HEADING}${event.text}`, ""]
    case "message.assistant":
      return event.text.trim() !== "" ? [event.text.trim(), ""] : []
    case "tool.call":
      return [`**→ ${event.name}** \`${JSON.stringify(event.input).slice(0, 200)}\``, ""]
    case "tool.result":
      return ["```", event.output.slice(0, 2_000), "```", ""]
    case "session.compacted":
      return [`> _context compacted — summary:_`, "", event.summary, ""]
    case "session.review":
      return [`> _code review — ${event.scope ?? "the current diff"}:_`, "", event.summary, ""]
    case "turn.completed":
      return [`> _turn: ${event.usage.input} in / ${event.usage.output} out (${event.model})_`, ""]
    default:
      return []
  }
}

/**
 * Render a journal as Markdown (for /export and the Ctrl+O pager). Uses the
 * raw replay, not the projector fold, so search reaches pruned and compacted
 * turns. Undone turns are kept but fenced and labelled.
 */
export function exportSessionMarkdown(journalPath: string): string {
  const { header, events } = SessionJournal.replay(journalPath)
  const lines: string[] = [
    `# butterfly session ${header.sessionId}`,
    "",
    `> started ${header.createdAt}`,
    "",
  ]
  const undone = undoneIndices(events)
  let inUndone = false
  events.forEach((event, index) => {
    const rendered = renderEvent(event, undone.has(index))
    // Region markers follow what actually prints, so bookkeeping-only regions
    // never open an empty fence.
    if (undone.has(index)) {
      if (rendered.length === 0) return
      if (!inUndone) {
        lines.push(UNDONE_OPEN, "")
        inUndone = true
      }
    } else if (inUndone) {
      lines.push(UNDONE_CLOSE, "")
      inUndone = false
    }
    lines.push(...rendered)
  })
  if (inUndone) lines.push(UNDONE_CLOSE, "")
  return lines.join("\n")
}
