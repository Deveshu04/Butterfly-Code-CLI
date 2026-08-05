import { readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import type { ToolDefinition } from "../tool/registry"
import type { DefRow, GraphDb } from "./db"

export const exploreInput = z.object({
  query: z
    .string()
    .describe("Symbol name (or name fragment) to explore, e.g. 'runUserTurn' or 'compact'"),
})

export const EXPLORE_MAX_SYMBOLS = 5
export const EXPLORE_MAX_BODY_LINES = 60

function renderSymbol(def: DefRow, cwd: string, db: GraphDb): string {
  let body = "(source unavailable)"
  try {
    const lines = readFileSync(join(cwd, def.file), "utf8").split("\n")
    const end = Math.min(def.endRow, def.row + EXPLORE_MAX_BODY_LINES - 1)
    body = lines.slice(def.row, end + 1).join("\n")
    if (end < def.endRow) body += `\n  … (${def.endRow - end} more lines — use read)`
  } catch {
    // file may have been deleted since the last sync
  }

  const callers = db
    .refs()
    .filter((ref) => ref.name === def.name && ref.file !== def.file)
    .map((ref) => `${ref.file} (${ref.count}×)`)

  const header = `${def.file}:${def.row + 1}  [${def.symbolKind} ${def.name}]`
  const callerLine =
    callers.length > 0 ? `\ncallers: ${callers.join(", ")}` : "\ncallers: none found"
  return `${header}\n${body}${callerLine}`
}

export function createExploreTool(opts: {
  db: () => GraphDb | undefined
  cwd: string
}): ToolDefinition<z.infer<typeof exploreInput>> {
  return {
    name: "explore",
    description:
      "Look up symbols in the code graph: returns each matching definition's source body plus the files that call it, in one step. Prefer this over grep+read when you know a symbol name.",
    inputSchema: exploreInput,
    async execute(input) {
      const db = opts.db()
      if (!db) {
        return { output: "Code graph not ready yet — use grep/read instead.", isError: true }
      }

      let matches = db.lookupDefs(input.query)
      if (matches.length === 0) matches = db.searchDefs(input.query)
      if (matches.length === 0) {
        return {
          output: `No symbols match "${input.query}" in the code graph. Try the grep tool for full-text search, or glob to find files.`,
        }
      }

      const shown = matches.slice(0, EXPLORE_MAX_SYMBOLS)
      const sections = shown.map((def) => renderSymbol(def, opts.cwd, db))
      const hidden = matches.length - shown.length
      const suffix = hidden > 0 ? `\n\n[${hidden} more matches not shown — refine the query]` : ""
      return { output: `${sections.join("\n\n")}${suffix}` }
    },
  }
}
