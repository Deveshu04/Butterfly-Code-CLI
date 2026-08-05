import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { z } from "zod"
import { applyEdit } from "../edit/apply"


export const PROJECT_MEMORY_CAP = 2_000
export const USER_MEMORY_CAP = 1_000

export interface MemoryPaths {
  /** .butterfly/PROJECT.md — git-committable, reviewable. */
  project: string
  /** ~/.config/butterfly/USER.md — machine-local. */
  user: string
}

export function memoryPaths(cwd: string, home: string): MemoryPaths {
  return {
    project: join(cwd, ".butterfly", "PROJECT.md"),
    user: join(home, ".config", "butterfly", "USER.md"),
  }
}

export interface LoadedMemory {
  project: string
  user: string
}

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return ""
  }
}

/** Read both files once at session start (frozen snapshot). */
export function loadMemory(paths: MemoryPaths): LoadedMemory {
  return { project: readOrEmpty(paths.project), user: readOrEmpty(paths.user) }
}

export const memoryOp = z.object({
  op: z.enum(["add", "replace", "remove"]),
  scope: z.enum(["project", "user"]),
  text: z.string().optional().describe("For add: the fact to append (one terse line)"),
  find: z.string().optional().describe("For replace/remove: exact substring to target"),
  replace: z.string().optional().describe("For replace: the new text"),
})
export type MemoryOp = z.infer<typeof memoryOp>

export type MemoryWriteResult =
  | { ok: true; content: string; staged?: boolean }
  | { ok: false; message: string }

/**
 * Write-time injection scan (OWASP ASI06 — memory poisoning). Conservative
 * pattern list: instruction-override phrasing and prompt-boundary spoofing.
 */
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions|rules|prompts)/i,
  /disregard\s+(all\s+|any\s+)?(previous|prior|above|earlier)/i,
  /you\s+are\s+now\s+(a|an|in)\b/i,
  /<\/?(system|assistant|instructions?)\s*>/i,
  /\bsystem\s*prompt\b.{0,40}\b(replace|override|reveal|print)/i,
  /exfiltrat/i,
]

export function scanForInjection(text: string): string | null {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) return `matched suspicious pattern ${pattern}`
  }
  return null
}

function capFor(scope: "project" | "user"): number {
  return scope === "project" ? PROJECT_MEMORY_CAP : USER_MEMORY_CAP
}

/**
 * Apply one delta with cap enforcement and injection scanning. When
 * approval mode is on, writes land in a pending file instead (staged=true).
 */
export function applyMemoryOp(
  paths: MemoryPaths,
  operation: MemoryOp,
  opts?: { approval?: boolean },
): MemoryWriteResult {
  const path = operation.scope === "project" ? paths.project : paths.user
  const current = readOrEmpty(path)

  const payload = `${operation.text ?? ""}${operation.replace ?? ""}`
  const flagged = scanForInjection(payload)
  if (flagged) {
    return {
      ok: false,
      message: `Rejected: the content looks like a prompt-injection attempt (${flagged}). Memory only stores plain project/user facts.`,
    }
  }

  let next: string
  switch (operation.op) {
    case "add": {
      if (!operation.text || operation.text.trim() === "") {
        return { ok: false, message: "add requires non-empty text." }
      }
      const line = `- ${operation.text.trim()}`
      next = current === "" ? `${line}\n` : `${current.trimEnd()}\n${line}\n`
      break
    }
    case "replace": {
      if (!operation.find || operation.replace === undefined) {
        return { ok: false, message: "replace requires find and replace." }
      }
      const result = applyEdit(current, operation.find, operation.replace)
      if (!result.ok) return { ok: false, message: `replace failed: ${result.message}` }
      next = result.content
      break
    }
    case "remove": {
      if (!operation.find) return { ok: false, message: "remove requires find." }
      const result = applyEdit(current, operation.find, "")
      if (!result.ok) return { ok: false, message: `remove failed: ${result.message}` }
      next = result.content.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "")
      break
    }
  }

  const cap = capFor(operation.scope)
  if (next.length > cap) {
    return {
      ok: false,
      message: `Memory over capacity (${next.length}/${cap} chars). Nothing was written. Consolidate first: merge or remove existing entries with replace/remove, then retry.`,
    }
  }

  if (opts?.approval) {
    const pendingPath = `${path}.pending-${Date.now()}.md`
    mkdirSync(dirname(pendingPath), { recursive: true })
    writeFileSync(pendingPath, next)
    return { ok: true, content: next, staged: true }
  }

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, next)
  return { ok: true, content: next }
}
