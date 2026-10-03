import type { ProviderPort } from "../provider/port"
import { SessionJournal } from "../session/journal"
import { applyMemoryOp, type MemoryPaths, memoryOp } from "./files"

export const REVIEWER_PROMPT = `You maintain a tiny, hard-capped memory file for a coding agent. From the transcript excerpt, extract AT MOST 3 durable facts worth remembering across sessions (build/test commands, architectural invariants, hard-won gotchas, user preferences). Most turns contain NOTHING durable — then reply with [].

Reply with ONLY a JSON array of operations, no prose:
[{"op":"add","scope":"project","text":"bun test runs all packages"}]
Allowed ops: {"op":"add","scope":"project"|"user","text":...} and {"op":"replace","scope":...,"find":...,"replace":...}. Facts must be terse single lines. Never restate the task itself; never store secrets.`

export interface ReviewDeps {
  provider: ProviderPort
  /** A cheap small_model — this runs after every Nth turn. */
  model: string
  journal: SessionJournal
  paths: MemoryPaths
  approval?: boolean
}

export interface ReviewOutcome {
  proposed: number
  applied: number
  rejected: number
}

const TURN_RENDER_CAP = 8_000

export function renderLatestTurn(journalPath: string): string {
  const { events } = SessionJournal.replay(journalPath)
  // Turn boundary = the last message a PERSON sent; auto-continue nudges
  // (synthetic) are part of the same turn.
  const lastUser = events.findLastIndex((e) => e.type === "message.user" && e.synthetic !== true)
  const slice = lastUser >= 0 ? events.slice(lastUser) : events
  const lines: string[] = []
  for (const event of slice) {
    if (event.type === "message.user")
      lines.push(`${event.synthetic === true ? "harness" : "user"}: ${event.text}`)
    else if (event.type === "message.assistant" && event.text !== "")
      lines.push(`assistant: ${event.text}`)
    else if (event.type === "tool.call")
      lines.push(`tool ${event.name}: ${JSON.stringify(event.input).slice(0, 200)}`)
    else if (event.type === "tool.result")
      lines.push(`result${event.isError ? " (error)" : ""}: ${event.output.slice(0, 300)}`)
  }
  return lines.join("\n").slice(0, TURN_RENDER_CAP)
}

export function extractJsonArray(text: string): unknown[] | null {
  const start = text.indexOf("[")
  const end = text.lastIndexOf("]")
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(text.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export async function reviewTurn(deps: ReviewDeps): Promise<ReviewOutcome> {
  const outcome: ReviewOutcome = { proposed: 0, applied: 0, rejected: 0 }
  try {
    const rendered = renderLatestTurn(deps.journal.path)
    if (rendered.trim() === "") return outcome

    let text = ""
    for await (const event of deps.provider.streamTurn({
      model: deps.model,
      messages: [
        { role: "system", content: REVIEWER_PROMPT },
        { role: "user", content: rendered },
      ],
    })) {
      if (event.type === "text-delta") text += event.text
      else if (event.type === "error") return outcome
    }

    const operations = extractJsonArray(text)
    if (!operations) return outcome

    for (const candidate of operations.slice(0, 3)) {
      outcome.proposed += 1
      const parsed = memoryOp.safeParse(candidate)
      if (!parsed.success) {
        outcome.rejected += 1
        continue
      }
      const result = applyMemoryOp(deps.paths, parsed.data, { approval: deps.approval })
      if (result.ok) outcome.applied += 1
      else outcome.rejected += 1
    }
    return outcome
  } catch {
    return outcome
  }
}
