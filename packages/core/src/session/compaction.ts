import { estimateTokens } from "../context/tokens"
import type { ProviderPort } from "../provider/port"
import { resolveToolName } from "../tool/repair"
import { settle } from "../tool/settle"
import type { TodoItem } from "../tool/tools/todo"
import { now, type SessionEvent, type Usage } from "./events"
import { SessionJournal } from "./journal"
import { foldTimeline, type TimelineEntry } from "./projector"
import { renderTodos, todosFromTimeline } from "./todo-state"

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
  /** The todo list standing right now (harness state — survives verbatim). */
  todos?: TodoItem[]
  /** Paths changed via the edit tool in the cut region, plus earlier cuts'. */
  files: string[]
}

/**
 * Files the edit tool changed in `entries`, plus those earlier compactions
 * recorded. Exact and cumulative, unlike the model-written file list.
 */
function editedFiles(entries: TimelineEntry[]): string[] {
  const files = new Set<string>()
  const pending = new Map<string, string>()
  for (const { event } of entries) {
    if (event.type === "session.compacted") {
      for (const file of event.files ?? []) files.add(file)
    } else if (event.type === "tool.call" && resolveToolName(event.name, ["edit"]) === "edit") {
      const path = (event.input as { file_path?: unknown } | null)?.file_path
      if (typeof path === "string") pending.set(event.callId, path)
    } else if (event.type === "tool.result" && !event.isError) {
      const path = pending.get(event.callId)
      if (path !== undefined) files.add(path)
    }
  }
  return [...files]
}

/**
 * Harness-authored sections appended to the summary: exact state the
 * summarizer cannot be trusted to carry, since it sees truncated tool inputs.
 */
export function harnessRecord(
  plan: Pick<CompactionPlan, "todos" | "files">,
  codeMap?: (files: string[]) => string,
): string {
  const sections: string[] = []
  if (plan.todos && plan.todos.length > 0) {
    sections.push(`## Todo list (harness record — current)\n${renderTodos(plan.todos)}`)
  }
  if (plan.files.length > 0) {
    sections.push(`## Files edited so far (harness record)\n${plan.files.join("\n")}`)
    // The code graph re-states where symbols in the edited files live, so the
    // next step need not re-read them to re-orient.
    const map = codeMap?.(plan.files).trim() ?? ""
    if (map !== "") sections.push(`## Code map of edited files (harness record)\n${map}`)
  }
  return sections.join("\n")
}

export interface ModelLimits {
  context: number
  output?: number
}

/** Overflow check: trigger before the window actually fills. */
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

/**
 * Keep the largest verbatim tail that fits keepTokens (at least the newest
 * user turn) and summarize the rest. Null when there is nothing to cut.
 */
export function planCompaction(
  events: SessionEvent[],
  opts?: { keepTokens?: number },
): CompactionPlan | null {
  const keepTokens = opts?.keepTokens ?? VERBATIM_TAIL_TOKENS
  const { entries } = foldTimeline(events)
  if (entries.length === 0) return null

  // Cut points include assistant steps, so one long turn can still be
  // compacted mid-turn.
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

  const todos = todosFromTimeline(entries.map((entry) => entry.event))
  return {
    keepFromIndex,
    cutRendered: settle(rendered, { maxChars: CUT_RENDER_MAX_CHARS }).text,
    ...(todos ? { todos } : {}),
    files: editedFiles(cut),
  }
}

export interface CompactionDeps {
  provider: ProviderPort
  /** Ideally a cheap small_model — compaction is summarization, not reasoning. */
  model: string
  journal: SessionJournal
  keepTokens?: number
  /** Budgeted symbol map for a set of files (the code graph), appended to the record. */
  codeMap?: (files: string[]) => string
}

/** Run the summarizer and journal the session.compacted event. */
export async function compactSession(
  deps: CompactionDeps,
): Promise<{ summary: string; keepFromIndex: number; usage: Usage } | null> {
  const { events } = SessionJournal.replay(deps.journal.path)
  const plan = planCompaction(events, { keepTokens: deps.keepTokens })
  if (!plan) return null

  let summary = ""
  let usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for await (const event of deps.provider.streamTurn({
    model: deps.model,
    messages: [
      { role: "system", content: COMPACTION_PROMPT },
      { role: "user", content: `Summarize this transcript segment:\n\n${plan.cutRendered}` },
    ],
  })) {
    if (event.type === "text-delta") summary += event.text
    else if (event.type === "finish") usage = event.usage
    else if (event.type === "error")
      throw new Error(`Compaction summarizer failed: ${event.message}`)
  }

  if (summary.trim() === "") return null

  const record = harnessRecord(plan, deps.codeMap)
  if (record !== "") summary = `${summary.trimEnd()}\n${record}`
  deps.journal.append({
    type: "session.compacted",
    summary,
    keepFromIndex: plan.keepFromIndex,
    ...(plan.todos ? { todos: plan.todos } : {}),
    ...(plan.files.length > 0 ? { files: plan.files } : {}),
    time: now(),
  })
  return { summary, keepFromIndex: plan.keepFromIndex, usage }
}
