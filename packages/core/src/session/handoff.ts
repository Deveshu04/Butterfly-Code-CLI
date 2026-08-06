import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { ProviderPort } from "../provider/port"
import { ToolRegistry } from "../tool/registry"
import { now, type SessionEvent, type Usage } from "./events"
import type { SessionJournal } from "./journal"
import { type RunnerEvent, runUserTurn } from "./runner"


export const HANDOFF_MAX_CHARS = 4_000
export const HANDOFF_TRUNCATION_MARKER = "\n\n…[handoff truncated at 4000 chars]"

export const HANDOFF_PROMPT = `This session is about to end and you cannot call tools now. Write a handoff note that lets someone else, a person or another agent, pick up the work from this note alone. Reply with the note and nothing else, using these Markdown sections in order:

# Task
What the user wants, in a sentence or two.
# Where things stand
What is finished, what is half done and what is stuck. Be specific.
# Continue with
The next concrete step.
# Files
File paths that were changed or matter, one per line.

Copy paths, commands and identifiers exactly. Use short list items. Include only facts from this conversation. Stay under ${HANDOFF_MAX_CHARS} characters.`

export function truncateHandoffDoc(text: string): { doc: string; truncated: boolean } {
  const trimmed = text.trim()
  if (trimmed.length <= HANDOFF_MAX_CHARS) return { doc: trimmed, truncated: false }
  const budget = Math.max(0, HANDOFF_MAX_CHARS - HANDOFF_TRUNCATION_MARKER.length)
  return { doc: `${trimmed.slice(0, budget)}${HANDOFF_TRUNCATION_MARKER}`, truncated: true }
}

export interface RunHandoffTurnDeps {
  provider: ProviderPort
  journal: SessionJournal
  model: string
  system: string
  cwd: string
  onEvent?: (event: RunnerEvent) => void
  signal?: AbortSignal
}

export interface HandoffTurnResult {
  doc: string
  truncated: boolean
  usage: Usage
}

export async function runHandoffTurn(deps: RunHandoffTurnDeps): Promise<HandoffTurnResult> {
  const registry = new ToolRegistry()
  const outcome = await runUserTurn(
    {
      provider: deps.provider,
      registry,
      journal: deps.journal,
      rules: { "*": "deny" },
      model: deps.model,
      system: deps.system,
      cwd: deps.cwd,
      maxSteps: 1,
      ...(deps.onEvent ? { onEvent: deps.onEvent } : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
    },
    HANDOFF_PROMPT,
  )
  const { doc, truncated } = truncateHandoffDoc(outcome.text)
  return { doc, truncated, usage: outcome.usage }
}

export interface HandoffPaths {
  /** The pending pointer a later session preloads. */
  main: string
  archiveDir: string
}

export function handoffPaths(cwd: string): HandoffPaths {
  return {
    main: join(cwd, ".butterfly", "handoff.md"),
    archiveDir: join(cwd, ".butterfly", "handoffs"),
  }
}

export interface SaveHandoffResult {
  path: string
  archivePath: string
  chars: number
  truncated: boolean
}

/** Minimal journal seam — anything append-shaped (SessionJournal) fits. */
export interface HandoffJournalSink {
  append(event: SessionEvent): void
}

export function saveHandoff(
  cwd: string,
  doc: string,
  truncated: boolean,
  journal: HandoffJournalSink,
): SaveHandoffResult {
  const paths = handoffPaths(cwd)
  mkdirSync(dirname(paths.main), { recursive: true })
  mkdirSync(paths.archiveDir, { recursive: true })
  writeFileSync(paths.main, doc)
  const ts = now().replace(/\D/g, "")
  const archivePath = join(paths.archiveDir, `${ts}.md`)
  writeFileSync(archivePath, doc)
  journal.append({
    type: "session.handoff",
    path: paths.main,
    archivePath,
    chars: doc.length,
    truncated,
    time: now(),
  })
  return { path: paths.main, archivePath, chars: doc.length, truncated }
}

/** Marks a handoff as already loaded — kept, not deleted, as a breadcrumb. */
const CONSUMED_SUFFIX = ".consumed"

export function consumeHandoff(cwd: string): string | undefined {
  const { main } = handoffPaths(cwd)
  let content: string
  try {
    content = readFileSync(main, "utf8")
  } catch {
    return undefined
  }
  try {
    renameSync(main, `${main}${CONSUMED_SUFFIX}`)
  } catch {
  }
  return content
}

/** Wraps a preloaded handoff doc for injection into a fresh session's first turn. */
export function renderHandoffPreload(doc: string): string {
  return `[handoff from a previous session — goal/state/next-move/files]\n${doc}`
}
