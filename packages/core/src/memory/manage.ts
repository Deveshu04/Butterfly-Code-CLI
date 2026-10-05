import { readFileSync, writeFileSync } from "node:fs"
import { type MemoryPaths, PROJECT_MEMORY_CAP, USER_MEMORY_CAP } from "./files"
import { isPromoted, listSkills, PROMOTION_THRESHOLD, type SkillMeta } from "./skills"

/**
 * What /memory and /skills show and edit: pure functions over the same files
 * the agent writes, so a person can review and undo what it learned.
 */

export interface MemoryLine {
  /** 1-based, numbered across project then user — what `/memory forget <n>` takes. */
  n: number
  scope: "project" | "user"
  text: string
}

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return ""
  }
}

export function memoryLines(paths: MemoryPaths): MemoryLine[] {
  const out: MemoryLine[] = []
  for (const scope of ["project", "user"] as const) {
    const text = readOrEmpty(scope === "project" ? paths.project : paths.user)
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue
      out.push({ n: out.length + 1, scope, text: line.replace(/^\s*-\s*/, "") })
    }
  }
  return out
}

function bar(used: number, cap: number, width = 16): string {
  const filled = Math.min(width, Math.round((used / cap) * width))
  return `[${"#".repeat(filled)}${".".repeat(width - filled)}] ${used}/${cap}`
}

export function renderMemoryView(paths: MemoryPaths): string {
  const lines = memoryLines(paths)
  const section = (scope: "project" | "user", path: string, cap: number) => {
    const used = readOrEmpty(path).length
    const rows = lines
      .filter((line) => line.scope === scope)
      .map((line) => `  ${String(line.n).padStart(2)}  ${line.text}`)
    return [
      `${scope.toUpperCase()}  ${bar(used, cap)}  ${path}`,
      ...(rows.length > 0 ? rows : ["      (empty)"]),
    ].join("\n")
  }
  return [
    section("project", paths.project, PROJECT_MEMORY_CAP),
    "",
    section("user", paths.user, USER_MEMORY_CAP),
    "",
    "learned automatically after turns that do real work (memory.autoReview) · frozen per session",
    "/memory add <fact> · /memory user <fact> · /memory forget <n> · /memory search <words>",
  ].join("\n")
}

/** Remove one numbered line. Returns the removed text, or null for a bad number. */
export function forgetMemoryLine(paths: MemoryPaths, n: number): MemoryLine | null {
  const target = memoryLines(paths).find((line) => line.n === n)
  if (!target) return null
  const path = target.scope === "project" ? paths.project : paths.user
  const kept: string[] = []
  let seen = 0
  const offset = memoryLines(paths).filter((line) => line.scope === "project").length
  const indexInFile = target.scope === "project" ? target.n : target.n - offset
  for (const line of readOrEmpty(path).split("\n")) {
    if (line.trim() === "") continue
    seen += 1
    if (seen !== indexInFile) kept.push(line)
  }
  writeFileSync(path, kept.length > 0 ? `${kept.join("\n")}\n` : "")
  return target
}

export function skillStatus(skill: SkillMeta): string {
  if (skill.origin === "human") return "active (yours)"
  if (isPromoted(skill)) return `active (learned, used ${skill.uses}x)`
  return `draft ${Math.min(skill.verified, PROMOTION_THRESHOLD)}/${PROMOTION_THRESHOLD} verified`
}

export function renderSkillsView(dirs: string[]): string {
  const skills = listSkills(dirs)
  if (skills.length === 0) {
    return [
      "no skills yet.",
      "they appear automatically: after a turn completes a multi-step procedure that will recur,",
      "the agent drafts one; two verified runs promote it into every session's prompt.",
      "or write your own: .butterfly/skills/<name>/SKILL.md (frontmatter: name, description).",
    ].join("\n")
  }
  const width = Math.max(...skills.map((s) => s.name.length))
  const rows = skills.map(
    (skill) =>
      `  ${skill.name.padEnd(width)}  ${skillStatus(skill).padEnd(26)}  ${skill.description}`,
  )
  return [
    ...rows,
    "",
    "/skills (picker) · /skills show <name> · /skills promote <name> · /skills delete <name>",
  ].join("\n")
}
