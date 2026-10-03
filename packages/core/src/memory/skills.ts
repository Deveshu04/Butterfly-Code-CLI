import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { estimateTokens } from "../context/tokens"


export interface SkillMeta {
  name: string
  description: string
  origin: "human" | "agent"
  verified: number
  /** Times the skill tool loaded it in a turn that then succeeded. */
  uses: number
  path: string
}

export const SKILLS_INDEX_TOKEN_CAP = 2_000
export const PROMOTION_THRESHOLD = 2

interface ParsedSkill {
  meta: SkillMeta
  body: string
}

function parseSkillFile(path: string): ParsedSkill | null {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return null
  }
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return null
  const front = match[1] ?? ""
  const body = (match[2] ?? "").trim()

  const field = (key: string): string | undefined =>
    front.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim()

  const name = field("name")
  const description = field("description")
  if (!name || !description) return null
  const origin = field("origin") === "agent" ? "agent" : "human"
  const verified = Number(field("verified") ?? 0) || 0
  const uses = Number(field("uses") ?? 0) || 0
  return { meta: { name, description, origin, verified, uses, path }, body }
}

/** Scan skill directories (project first, then user) for SKILL.md files. */
export function listSkills(dirs: string[]): SkillMeta[] {
  const skills: SkillMeta[] = []
  const seen = new Set<string>()
  for (const dir of dirs) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const parsed = parseSkillFile(join(dir, entry, "SKILL.md"))
      if (parsed && !seen.has(parsed.meta.name)) {
        seen.add(parsed.meta.name)
        skills.push(parsed.meta)
      }
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

/** Skills eligible for the L0 index: human-authored, or agent+verified. */
export function promotedSkills(skills: SkillMeta[]): SkillMeta[] {
  return skills.filter((skill) => skill.origin === "human" || skill.verified >= PROMOTION_THRESHOLD)
}

/** Render the L0 index (capped). Empty string when no promoted skills. */
export function skillsIndex(dirs: string[]): string {
  const promoted = promotedSkills(listSkills(dirs))
  if (promoted.length === 0) return ""
  const lines: string[] = []
  for (const skill of promoted) {
    const line = `${skill.name} — ${skill.description}`
    if (estimateTokens([...lines, line].join("\n")) > SKILLS_INDEX_TOKEN_CAP) break
    lines.push(line)
  }
  return lines.join("\n")
}

/** Load a skill body (L1). */
export function readSkill(dirs: string[], name: string): string | null {
  for (const dir of dirs) {
    const parsed = parseSkillFile(join(dir, name, "SKILL.md"))
    if (parsed) return parsed.body
  }
  return null
}

/** Set (or insert) one frontmatter field, leaving the rest byte-identical. */
function setField(raw: string, key: string, value: string): string {
  const pattern = new RegExp(`^${key}:.*$`, "m")
  const frontEnd = raw.search(/\r?\n---\r?\n?/)
  if (frontEnd > 0 && pattern.test(raw.slice(0, frontEnd))) {
    return raw.replace(pattern, `${key}: ${value}`)
  }
  return raw.replace(/^---\r?\n/, (m) => `${m}${key}: ${value}\n`)
}

function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}

function findSkill(dirs: string[], name: string): ParsedSkill | null {
  for (const dir of dirs) {
    const parsed = parseSkillFile(join(dir, name, "SKILL.md"))
    if (parsed) return parsed
  }
  return null
}

/** Bump the verified counter after a successful gated run. */
export function recordSkillRun(dirs: string[], name: string, success: boolean): void {
  if (!success) return
  const parsed = findSkill(dirs, name)
  if (!parsed) return
  const raw = readFileSync(parsed.meta.path, "utf8")
  atomicWrite(parsed.meta.path, setField(raw, "verified", String(parsed.meta.verified + 1)))
}

export function recordSkillUse(dirs: string[], name: string, success: boolean): SkillMeta | null {
  const parsed = findSkill(dirs, name)
  if (!parsed) return null
  let raw = readFileSync(parsed.meta.path, "utf8")
  raw = setField(raw, "uses", String(parsed.meta.uses + 1))
  if (success && parsed.meta.origin === "agent") {
    raw = setField(raw, "verified", String(parsed.meta.verified + 1))
  }
  atomicWrite(parsed.meta.path, raw)
  return parseSkillFile(parsed.meta.path)?.meta ?? null
}

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{2,47}$/
export const SKILL_BODY_CAP = 4_000
export const MAX_AGENT_SKILLS = 40

export interface SkillDraft {
  name: string
  description: string
  body: string
}

export type SkillWriteResult =
  | { status: "drafted" | "reinforced" | "promoted"; meta: SkillMeta }
  | { status: "rejected"; message: string }

export function writeAgentSkill(
  dir: string,
  draft: SkillDraft,
  scan: (text: string) => string | null,
  now: Date = new Date(),
): SkillWriteResult {
  const name = draft.name.trim().toLowerCase()
  if (!SKILL_NAME_RE.test(name)) {
    return {
      status: "rejected",
      message: `invalid skill name "${draft.name}" (kebab-case, 3-48 chars)`,
    }
  }
  const description = draft.description.replace(/\s+/g, " ").trim().slice(0, 200)
  const body = draft.body.trim()
  if (description === "" || body === "") {
    return { status: "rejected", message: "skill needs a description and a body" }
  }
  if (body.length > SKILL_BODY_CAP) {
    return {
      status: "rejected",
      message: `skill body over ${SKILL_BODY_CAP} chars — keep procedures short`,
    }
  }
  const flagged = scan(`${description}\n${body}`)
  if (flagged) return { status: "rejected", message: `rejected: ${flagged}` }

  const path = join(dir, name, "SKILL.md")
  const existing = parseSkillFile(path)
  const date = now.toISOString().slice(0, 10)
  if (existing) {
    if (existing.meta.origin !== "agent") {
      return { status: "rejected", message: `"${name}" is human-authored — not overwriting it` }
    }
    const verified = existing.meta.verified + 1
    const next = [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      "origin: agent",
      `verified: ${verified}`,
      `uses: ${existing.meta.uses}`,
      `updated: ${date}`,
      "---",
      body,
      "",
    ].join("\n")
    atomicWrite(path, next)
    const meta = parseSkillFile(path)?.meta
    if (!meta) return { status: "rejected", message: "write failed" }
    return { status: verified === PROMOTION_THRESHOLD ? "promoted" : "reinforced", meta }
  }

  const agentCount = listSkills([dir]).filter((skill) => skill.origin === "agent").length
  if (agentCount >= MAX_AGENT_SKILLS) {
    return {
      status: "rejected",
      message: `skill library full (${MAX_AGENT_SKILLS} agent skills) — delete stale ones with /skills delete`,
    }
  }
  mkdirSync(join(dir, name), { recursive: true })
  atomicWrite(
    path,
    [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      "origin: agent",
      "verified: 1",
      "uses: 0",
      `created: ${date}`,
      "---",
      body,
      "",
    ].join("\n"),
  )
  const meta = parseSkillFile(path)?.meta
  if (!meta) return { status: "rejected", message: "write failed" }
  return { status: "drafted", meta }
}

/** Human promotion from /skills promote: sets verified to the threshold. */
export function promoteSkill(dirs: string[], name: string): SkillMeta | null {
  const parsed = findSkill(dirs, name)
  if (!parsed) return null
  if (parsed.meta.verified < PROMOTION_THRESHOLD) {
    const raw = readFileSync(parsed.meta.path, "utf8")
    atomicWrite(parsed.meta.path, setField(raw, "verified", String(PROMOTION_THRESHOLD)))
  }
  return parseSkillFile(parsed.meta.path)?.meta ?? null
}

/** Delete a skill directory. Returns the removed path, or null when unknown. */
export function deleteSkill(dirs: string[], name: string): string | null {
  const parsed = findSkill(dirs, name)
  if (!parsed) return null
  rmSync(join(parsed.meta.path, ".."), { recursive: true, force: true })
  return parsed.meta.path
}

export function isPromoted(skill: SkillMeta): boolean {
  return skill.origin === "human" || skill.verified >= PROMOTION_THRESHOLD
}

export function draftSkills(dirs: string[]): SkillMeta[] {
  return listSkills(dirs).filter((skill) => !isPromoted(skill))
}
