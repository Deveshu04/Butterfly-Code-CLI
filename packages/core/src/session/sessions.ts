import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import type { SessionEvent } from "./events"
import { SessionJournal } from "./journal"


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

export function forkSession(journalPath: string, dir: string): string {
  const { header, events } = SessionJournal.replay(journalPath)
  const forked = SessionJournal.create(dir)
  for (const event of events) forked.append(event)
  void header
  return forked.path
}

const PROMPT_HEADING = "## ❯ "
const UNDONE_PROMPT_HEADING = "## ⤺ (undone) ❯ "
const UNDONE_OPEN = "> _⤺ undone — /undo rewound the following out of the conversation:_"
const UNDONE_CLOSE = "> _⤺ end of undone_"

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
