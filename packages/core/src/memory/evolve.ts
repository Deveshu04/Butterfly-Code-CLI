import { copyFileSync, readFileSync, writeFileSync } from "node:fs"
import type { ProviderPort } from "../provider/port"
import type { SessionEvent, Usage } from "../session/events"
import { SessionJournal } from "../session/journal"
import {
  applyMemoryOp,
  type MemoryPaths,
  memoryOp,
  PROJECT_MEMORY_CAP,
  scanForInjection,
  USER_MEMORY_CAP,
} from "./files"
import { extractJsonArray, renderLatestTurn } from "./reviewer"
import { listSkills, PROMOTION_THRESHOLD, recordSkillUse, writeAgentSkill } from "./skills"

/**
 * Post-turn self-evolution:
 *  1. Memory: durable facts land in PROJECT.md / USER.md through the capped,
 *     scanned writer; a full file is consolidated (backup kept) rather than
 *     dropping the fact.
 *  2. Skills: a successful multi-step procedure becomes a draft skill; it is
 *     promoted into the prefix index after 2 verified runs.
 * A deterministic gate skips turns with nothing to learn. Never throws.
 */

export const EVOLVE_PROMPT = `You maintain the long-term memory and skill library of a coding agent. Read the transcript excerpt of the turn that just finished and decide what is worth keeping FOREVER. Most turns contain nothing — then reply [].

Reply with ONLY a JSON array, no prose. Allowed items (at most 4):
{"op":"add","scope":"project"|"user","text":"<one terse line>"}
  durable facts: exact build/test/lint commands, architecture invariants, hard-won gotchas (project); stated preferences about how to work (user)
{"op":"replace","scope":"project"|"user","find":"<exact existing text>","replace":"<new text>"}
  correct a stale fact that is shown under CURRENT MEMORY
{"op":"skill","name":"<kebab-case>","description":"<when to use it, one line>","body":"<numbered steps with exact commands>"}
  ONLY when the turn completed a multi-step procedure that will recur (release, migration, deploy, debugging recipe). If an EXISTING SKILL below covers the same procedure, reuse its exact name (that reinforces it) and improve its body.

Never store the task itself, secrets, file contents, or anything already in CURRENT MEMORY.`

export interface EvolveDeps {
  provider: ProviderPort
  model: string
  journal: SessionJournal
  paths: MemoryPaths
  /** Where agent skills are written (project dir). */
  skillDir: string
  /** All skill dirs (project first) — for reinforcement lookup + usage tracking. */
  skillDirs: string[]
  /** Toggle skill authoring (config memory.autoSkills). Default true. */
  autoSkills?: boolean
  approval?: boolean
  now?: () => Date
}

export interface EvolveOutcome {
  /** True when the gate let the turn through to the model. */
  reviewed: boolean
  memoryAdded: string[]
  memoryUpdated: number
  rejected: number
  consolidated: ("project" | "user")[]
  skillsDrafted: string[]
  skillsReinforced: { name: string; verified: number }[]
  skillsPromoted: string[]
  skillsUsed: string[]
  /** Tokens the evolver's own model calls cost (review + consolidation). */
  usage: Usage
}

export function emptyOutcome(): EvolveOutcome {
  return {
    reviewed: false,
    memoryAdded: [],
    memoryUpdated: 0,
    rejected: 0,
    consolidated: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    skillsDrafted: [],
    skillsReinforced: [],
    skillsPromoted: [],
    skillsUsed: [],
  }
}

export interface TurnFacts {
  userText: string
  toolCalls: number
  toolErrors: number
  lastResultErrored: boolean
  completed: boolean
  skillsLoaded: string[]
}

/** Facts about the latest turn, straight from the journal (zero tokens). */
export function latestTurnFacts(events: SessionEvent[]): TurnFacts {
  // Turn boundary = the last message a PERSON sent; auto-continue nudges
  // (synthetic) are part of the same turn.
  const lastUser = events.findLastIndex((e) => e.type === "message.user" && e.synthetic !== true)
  const slice = lastUser >= 0 ? events.slice(lastUser) : events
  const facts: TurnFacts = {
    userText: "",
    toolCalls: 0,
    toolErrors: 0,
    lastResultErrored: false,
    completed: false,
    skillsLoaded: [],
  }
  for (const event of slice) {
    if (event.type === "message.user" && event.synthetic !== true) facts.userText = event.text
    else if (event.type === "tool.call") {
      facts.toolCalls += 1
      const input = event.input as { name?: unknown } | null
      if (event.name === "skill" && typeof input?.name === "string") {
        facts.skillsLoaded.push(input.name)
      }
    } else if (event.type === "tool.result") {
      if (event.isError) facts.toolErrors += 1
      facts.lastResultErrored = event.isError
    } else if (event.type === "turn.completed") facts.completed = true
  }
  return facts
}

const PREFERENCE_CUE =
  /\b(always|never|prefer|don'?t|do not|remember|from now on|instead of|make sure|convention|we use|i use|i like)\b/i

/**
 * The cost gate. A turn is worth a review when it did real work (≥ 2 tool
 * calls and finished without ending on an error) or the user stated
 * something preference-shaped. Pure chat and failed turns are skipped.
 */
export function worthReviewing(facts: TurnFacts): boolean {
  if (!facts.completed) return false
  if (PREFERENCE_CUE.test(facts.userText)) return true
  return facts.toolCalls >= 2 && !facts.lastResultErrored
}

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return ""
  }
}

async function complete(
  provider: ProviderPort,
  model: string,
  system: string,
  user: string,
  usage?: Usage,
): Promise<string | null> {
  let text = ""
  for await (const event of provider.streamTurn({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  })) {
    if (event.type === "text-delta") text += event.text
    else if (event.type === "finish" && usage) {
      usage.input += event.usage.input
      usage.output += event.usage.output
      usage.cacheRead += event.usage.cacheRead
      usage.cacheWrite += event.usage.cacheWrite
    } else if (event.type === "error") return null
  }
  return text
}

const CONSOLIDATE_PROMPT = `You compact a coding agent's long-term memory file. Rewrite it as terse "- " bullet lines: merge duplicates, drop stale or low-value lines, keep every exact command and invariant. The result MUST be under the character budget given. Reply with ONLY the new file content.`

/**
 * Memory full: rewrite it tighter rather than drop the new fact. The rewrite
 * must pass the injection scan, fit in 75% of the cap and keep at least a
 * third of the old size. The previous file is kept as `<file>.bak`.
 */
async function consolidate(
  deps: EvolveDeps,
  scope: "project" | "user",
  usage?: Usage,
): Promise<boolean> {
  const path = scope === "project" ? deps.paths.project : deps.paths.user
  const cap = scope === "project" ? PROJECT_MEMORY_CAP : USER_MEMORY_CAP
  const current = readOrEmpty(path)
  if (current.trim() === "") return false
  const budget = Math.floor(cap * 0.75)
  const reply = await complete(
    deps.provider,
    deps.model,
    CONSOLIDATE_PROMPT,
    `Character budget: ${budget}\n\n${current}`,
    usage,
  )
  if (reply === null) return false
  const next = `${reply
    .replace(/^```[a-z]*\n?|```$/gm, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "")
    .join("\n")}\n`
  if (next.length > budget || next.length < current.length / 3) return false
  if (scanForInjection(next)) return false
  if (deps.approval) {
    writeFileSync(`${path}.pending-${Date.now()}.md`, next)
    return true
  }
  copyFileSync(path, `${path}.bak`)
  writeFileSync(path, next)
  return true
}

/** One post-turn evolution pass. Never throws. */
export async function evolveAfterTurn(deps: EvolveDeps): Promise<EvolveOutcome> {
  const outcome = emptyOutcome()
  try {
    const { events } = SessionJournal.replay(deps.journal.path)
    const facts = latestTurnFacts(events)
    const succeeded = facts.completed && !facts.lastResultErrored

    // Usage-based verification: drafts the model actually loaded and
    // followed in a successful turn earn a verified run (zero tokens).
    for (const name of [...new Set(facts.skillsLoaded)]) {
      const before = listSkills(deps.skillDirs).find((skill) => skill.name === name)
      const after = recordSkillUse(deps.skillDirs, name, succeeded)
      if (!after) continue
      outcome.skillsUsed.push(name)
      if (
        before &&
        before.origin === "agent" &&
        before.verified < PROMOTION_THRESHOLD &&
        after.verified >= PROMOTION_THRESHOLD
      ) {
        outcome.skillsPromoted.push(name)
      }
    }

    if (!worthReviewing(facts)) return outcome
    outcome.reviewed = true

    const rendered = renderLatestTurn(deps.journal.path)
    if (rendered.trim() === "") return outcome
    const skills = listSkills(deps.skillDirs).filter((skill) => skill.origin === "agent")
    const context = [
      `CURRENT MEMORY (project):\n${readOrEmpty(deps.paths.project).trim() || "(empty)"}`,
      `CURRENT MEMORY (user):\n${readOrEmpty(deps.paths.user).trim() || "(empty)"}`,
      deps.autoSkills === false
        ? "SKILLS: disabled — do not propose skill items."
        : `EXISTING SKILLS:\n${skills.map((s) => `${s.name} — ${s.description}`).join("\n") || "(none)"}`,
      `TURN:\n${rendered}`,
    ].join("\n\n")

    const reply = await complete(deps.provider, deps.model, EVOLVE_PROMPT, context, outcome.usage)
    if (reply === null) return outcome
    const items = extractJsonArray(reply)
    if (!items) return outcome

    const full = new Set<"project" | "user">()
    const retry: { op: "add"; scope: "project" | "user"; text: string }[] = []
    for (const item of items.slice(0, 4)) {
      const record = item as Record<string, unknown> | null
      if (record?.["op"] === "skill") {
        if (deps.autoSkills === false || !succeeded) {
          outcome.rejected += 1
          continue
        }
        const result = writeAgentSkill(
          deps.skillDir,
          {
            name: String(record["name"] ?? ""),
            description: String(record["description"] ?? ""),
            body: String(record["body"] ?? ""),
          },
          scanForInjection,
          deps.now?.(),
        )
        if (result.status === "drafted") outcome.skillsDrafted.push(result.meta.name)
        else if (result.status === "reinforced" || result.status === "promoted") {
          outcome.skillsReinforced.push({ name: result.meta.name, verified: result.meta.verified })
          if (result.status === "promoted") outcome.skillsPromoted.push(result.meta.name)
        } else outcome.rejected += 1
        continue
      }
      const parsed = memoryOp.safeParse(item)
      if (!parsed.success || parsed.data.op === "remove") {
        outcome.rejected += 1
        continue
      }
      const result = applyMemoryOp(deps.paths, parsed.data, { approval: deps.approval })
      if (result.ok) {
        if (parsed.data.op === "add") outcome.memoryAdded.push(parsed.data.text ?? "")
        else outcome.memoryUpdated += 1
      } else if (parsed.data.op === "add" && /over capacity/.test(result.message)) {
        full.add(parsed.data.scope)
        retry.push({ op: "add", scope: parsed.data.scope, text: parsed.data.text ?? "" })
      } else outcome.rejected += 1
    }

    for (const scope of full) {
      if (await consolidate(deps, scope, outcome.usage)) outcome.consolidated.push(scope)
    }
    for (const op of retry) {
      const result = outcome.consolidated.includes(op.scope)
        ? applyMemoryOp(deps.paths, op, { approval: deps.approval })
        : { ok: false as const, message: "" }
      if (result.ok) outcome.memoryAdded.push(op.text)
      else outcome.rejected += 1
    }
    return outcome
  } catch {
    return outcome
  }
}

/** One human line for the transcript, or "" when nothing changed. */
export function describeEvolution(outcome: EvolveOutcome): string {
  const parts: string[] = []
  if (outcome.memoryAdded.length > 0) {
    parts.push(
      `remembered ${outcome.memoryAdded.length === 1 ? `"${outcome.memoryAdded[0]}"` : `${outcome.memoryAdded.length} facts`}`,
    )
  }
  if (outcome.memoryUpdated > 0) parts.push(`updated ${outcome.memoryUpdated} memory line(s)`)
  if (outcome.consolidated.length > 0)
    parts.push(`consolidated ${outcome.consolidated.join("+")} memory`)
  for (const name of outcome.skillsDrafted) {
    parts.push(`drafted skill ${name} (1/${PROMOTION_THRESHOLD} verified)`)
  }
  for (const { name, verified } of outcome.skillsReinforced) {
    if (!outcome.skillsPromoted.includes(name)) {
      parts.push(
        `reinforced skill ${name} (${Math.min(verified, PROMOTION_THRESHOLD)}/${PROMOTION_THRESHOLD})`,
      )
    }
  }
  for (const name of outcome.skillsPromoted)
    parts.push(`promoted skill ${name} — active next session`)
  return parts.length === 0 ? "" : `evolved: ${parts.join(" · ")}`
}
