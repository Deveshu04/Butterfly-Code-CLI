import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { estimateTokens } from "../context/tokens"


export interface SkillMeta {
  name: string
  description: string
  origin: "human" | "agent"
  verified: number
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
  return { meta: { name, description, origin, verified, path }, body }
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

/** Bump the verified counter after a successful gated run. */
export function recordSkillRun(dirs: string[], name: string, success: boolean): void {
  if (!success) return
  for (const dir of dirs) {
    const path = join(dir, name, "SKILL.md")
    const parsed = parseSkillFile(path)
    if (!parsed) continue
    const raw = readFileSync(path, "utf8")
    const next = /^verified:\s*\d+$/m.test(raw)
      ? raw.replace(/^verified:\s*(\d+)$/m, (_, n: string) => `verified: ${Number(n) + 1}`)
      : raw.replace(/^---\r?\n/, (m) => `${m}verified: 1\n`)
    writeFileSync(path, next)
    return
  }
}
