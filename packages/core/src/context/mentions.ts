import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, join, relative } from "node:path"
import type { GraphDb } from "../graph/db"
import { settle } from "../tool/settle"
import { DEFAULT_IGNORED_SEGMENTS } from "../tool/tools/glob"


const MENTION_TOKEN = /@(?:"([^"]+)"|([^\s@]+))/g

export const MENTION_CONTEXT_MAX_CHARS = 4_000

function toRelSlash(cwd: string, path: string): string {
  const rel = isAbsolute(path) ? relative(cwd, path) : path
  return rel.replaceAll("\\", "/")
}

/** Raw `@token` candidates in order of first appearance, deduped. */
export function extractMentions(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const match of text.matchAll(MENTION_TOKEN)) {
    const token = match[1] ?? match[2]
    if (!token || seen.has(token)) continue
    seen.add(token)
    out.push(token)
  }
  return out
}

export interface ExpandedMention {
  path: string
  content: string
  truncated: boolean
}

export function expandMentions(
  cwd: string,
  text: string,
  opts?: { maxCharsPerFile?: number },
): ExpandedMention[] {
  const results: ExpandedMention[] = []
  for (const token of extractMentions(text)) {
    const rel = toRelSlash(cwd, token)
    const abs = join(cwd, rel)
    if (!existsSync(abs)) continue
    let raw: string
    try {
      raw = readFileSync(abs, "utf8")
    } catch {
      continue
    }
    const settled = settle(raw, { maxChars: opts?.maxCharsPerFile ?? MENTION_CONTEXT_MAX_CHARS })
    results.push({ path: rel, content: settled.text, truncated: settled.truncated })
  }
  return results
}

/** Renders expanded mentions into one block to attach alongside the task text. */
export function renderMentionBlock(mentions: ExpandedMention[]): string {
  if (mentions.length === 0) return ""
  const sections = mentions.map(
    (m) => `--- @${m.path} ---\n${m.content}${m.truncated ? "\n[... truncated ...]" : ""}`,
  )
  return `[attached files — mentioned with @]\n${sections.join("\n\n")}`
}

export function listMentionCandidates(cwd: string, db?: GraphDb): string[] {
  if (db) {
    const files = db.allFiles()
    if (files.length > 0) return files
  }
  const glob = new Bun.Glob("**/*")
  const out: string[] = []
  for (const entry of glob.scanSync({ cwd, onlyFiles: true, dot: false })) {
    const rel = entry.replaceAll("\\", "/")
    if (DEFAULT_IGNORED_SEGMENTS.some((segment) => rel.split("/").includes(segment))) continue
    out.push(rel)
  }
  out.sort()
  return out
}
