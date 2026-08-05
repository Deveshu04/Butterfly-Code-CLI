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
