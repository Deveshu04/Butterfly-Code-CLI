import { estimateTokens } from "../context/tokens"
import type { DefRow, GraphDb } from "./db"
import { type RankOptions, rankedDefinitions } from "./rank"

export interface SkeletonOptions extends RankOptions {
  budgetTokens?: number
}

export const DEFAULT_SKELETON_TOKENS = 1_000

function render(chosen: DefRow[]): string {
  const byFile = new Map<string, DefRow[]>()
  for (const def of chosen) {
    const list = byFile.get(def.file) ?? []
    list.push(def)
    byFile.set(def.file, list)
  }
  const sections: string[] = []
  for (const [file, defs] of byFile) {
    const lines = defs.map((d) => `  ${d.symbolKind} ${d.name}  :${d.row + 1}`)
    sections.push(`${file}:\n${lines.join("\n")}`)
  }
  return sections.join("\n")
}

/**
 * The budgeted repo map injected at turn start: ranked definitions grouped
 * by file, signatures only — never bodies. Empty string when the graph is
 * empty or the budget is too small for anything useful.
 */
export function buildSkeleton(db: GraphDb, opts?: SkeletonOptions): string {
  const budget = opts?.budgetTokens ?? DEFAULT_SKELETON_TOKENS
  const ranked = rankedDefinitions(db, opts)
  if (ranked.length === 0) return ""

  const chosen: DefRow[] = []
  for (const def of ranked) {
    chosen.push(def)
    if (estimateTokens(render(chosen)) > budget) {
      chosen.pop()
      break
    }
  }
  return chosen.length === 0 ? "" : render(chosen)
}

const IDENT = /[A-Za-z_$][A-Za-z0-9_$]*/g
const PATHISH = /[A-Za-z0-9_.\-/]+\.[A-Za-z]{1,5}\b/g

function looksLikeSymbol(word: string): boolean {
  // camelCase / PascalCase / snake_case or long enough to be specific —
  // plain short English ("file", "test", "make") would match noise.
  return word.length >= 4 && (/[a-z][A-Z]|_|^[A-Z][a-z]+[A-Z]/.test(word) || word.length >= 8)
}

export function focusedSkeleton(db: GraphDb, text: string, budgetTokens = 300): string {
  const lines: string[] = []
  const seen = new Set<string>()
  const push = (line: string): boolean => {
    if (seen.has(line)) return true
    if (estimateTokens([...lines, line].join("\n")) > budgetTokens) return false
    seen.add(line)
    lines.push(line)
    return true
  }

  for (const raw of text.match(PATHISH) ?? []) {
    const files = db.findFiles(raw)
    if (files.length !== 1 || !files[0]) continue
    const defs = db.fileDefs(files[0]).slice(0, 8)
    const names = defs.map((d) => `${d.name}:${d.row + 1}`).join(", ")
    if (!push(`${files[0]}${names ? ` — ${names}` : ""}`)) break
  }
  const words = [...new Set(text.match(IDENT) ?? [])].filter(looksLikeSymbol)
  for (const word of words) {
    const defs = db.lookupDefs(word).slice(0, 3)
    let full = false
    for (const def of defs) {
      const users = db.callers(def.name).length
      if (
        !push(
          `${def.symbolKind} ${def.name} — ${def.file}:${def.row + 1}${users > 0 ? ` (used in ${users} files)` : ""}`,
        )
      ) {
        full = true
        break
      }
    }
    if (full) break
  }
  return lines.join("\n")
}
