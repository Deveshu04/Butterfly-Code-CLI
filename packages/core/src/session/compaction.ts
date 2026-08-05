import { estimateTokens } from "../context/tokens"
import type { ProviderPort } from "../provider/port"
import { settle } from "../tool/settle"
import { now, type SessionEvent, type Usage } from "./events"
import { SessionJournal } from "./journal"
import { foldTimeline, type TimelineEntry } from "./projector"

export const OUTPUT_RESERVE_TOKENS = 16_384
export const VERBATIM_TAIL_TOKENS = 10_000
const CUT_RENDER_MAX_CHARS = 60_000

export const COMPACTION_PROMPT = `Summarize the earlier part of this coding session so the work can continue without it. Your summary replaces those messages, so anything you leave out is lost.

Write Markdown with these sections, in this order:

# Task
What the user asked for, and every requirement they stated.
# Decisions
Choices made so far and the reasons, plus constraints discovered along the way (conventions, tooling, approaches that failed and should not be retried).
# Progress
Three short lists: finished, in progress, stuck.
# Open questions
Anything unresolved or waiting on the user. Write "none" if there is nothing.
# Continue with
The single next step.
# Files
Every file path that was read or changed and still matters, one per line.

Copy paths, commands, identifiers and error messages exactly as they appear. Use short list items. Include only facts found in the transcript.`

export interface CompactionPlan {
  /** Original event index the verbatim tail starts at (a user-turn boundary). */
  keepFromIndex: number
  /** Textual rendering of everything being cut, fed to the summarizer. */
  cutRendered: string
}

export interface ModelLimits {
  context: number
  output?: number
}

export function needsCompaction(lastTurnUsage: Usage, limits: ModelLimits): boolean {
  const reserve =
    limits.output === undefined ? OUTPUT_RESERVE_TOKENS : Math.min(limits.output, OUTPUT_RESERVE_TOKENS)
  return lastTurnUsage.input + lastTurnUsage.output + reserve >= limits.context
}

function renderEvent(event: SessionEvent): string {
  switch (event.type) {
    case "message.user":
      return `user: ${event.text}`
    case "message.assistant":
      return event.text === "" ? "" : `assistant: ${event.text}`
    case "tool.call":
      return `tool ${event.name} input: ${JSON.stringify(event.input).slice(0, 300)}`
    case "tool.result":
      return `tool result${event.isError ? " (error)" : ""}: ${event.output.slice(0, 1_000)}`
    case "session.compacted":
      return `previous summary:\n${event.summary}`
    case "session.review":
      return `code review of ${event.scope ?? "the current diff"}:\n${event.summary}`
    default:
      return ""
  }
}

function entryTokens(entry: TimelineEntry): number {
  return estimateTokens(JSON.stringify(entry.event))
}

export function planCompaction(
  events: SessionEvent[],
  opts?: { keepTokens?: number },
): CompactionPlan | null {
  const keepTokens = opts?.keepTokens ?? VERBATIM_TAIL_TOKENS
  const { entries } = foldTimeline(events)
  if (entries.length === 0) return null

  const boundaries = entries
    .filter(
      (entry) => entry.event.type === "message.user" || entry.event.type === "message.assistant",
    )
    .map((entry) => entry.index)
  if (boundaries.length === 0) return null

  let keepFromIndex: number | undefined
  for (const boundary of boundaries) {
    const tailTokens = entries
      .filter((entry) => entry.index >= boundary)
      .reduce((sum, entry) => sum + entryTokens(entry), 0)
    if (tailTokens <= keepTokens) {
      keepFromIndex = boundary
      break
    }
  }
  keepFromIndex ??= boundaries.at(-1)
  if (keepFromIndex === undefined) return null

  const cut = entries.filter((entry) => entry.index < keepFromIndex)
  const rendered = cut
    .map((entry) => renderEvent(entry.event))
    .filter((line) => line !== "")
    .join("\n\n")
  if (rendered.trim() === "") return null

  return {
    keepFromIndex,
    cutRendered: settle(rendered, { maxChars: CUT_RENDER_MAX_CHARS }).text,
  }
}

export interface CompactionDeps {
  provider: ProviderPort
  /** Ideally a cheap small_model — compaction is summarization, not reasoning. */
  model: string
  journal: SessionJournal
  keepTokens?: number
}

/** Run the summarizer and journal the session.compacted event. */
export async function compactSession(
  deps: CompactionDeps,
): Promise<{ summary: string; keepFromIndex: number } | null> {
  const { events } = SessionJournal.replay(deps.journal.path)
  const plan = planCompaction(events, { keepTokens: deps.keepTokens })
  if (!plan) return null

  let summary = ""
  for await (const event of deps.provider.streamTurn({
    model: deps.model,
    messages: [
      { role: "system", content: COMPACTION_PROMPT },
      { role: "user", content: `Summarize this transcript segment:\n\n${plan.cutRendered}` },
    ],
  })) {
    if (event.type === "text-delta") summary += event.text
    else if (event.type === "error")
      throw new Error(`Compaction summarizer failed: ${event.message}`)
  }

  if (summary.trim() === "") return null

  deps.journal.append({
    type: "session.compacted",
    summary,
    keepFromIndex: plan.keepFromIndex,
    time: now(),
  })
  return { summary, keepFromIndex: plan.keepFromIndex }
}
