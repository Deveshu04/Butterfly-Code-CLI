import { readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import type { ToolDefinition } from "../tool/registry"
import type { DefRow, GraphDb } from "./db"
import { analyzeProject, moduleOverview, PROJECT_MAP_FILE } from "./project-map"
import { buildSkeleton } from "./skeleton"

export const exploreInput = z.object({
  op: z
    .enum(["symbol", "outline", "deps", "map"])
    .optional()
    .describe(
      "symbol (default): definition bodies + callers. outline: a file's symbols with line ranges, imports-from and used-by — far cheaper than reading it. deps: what a file/symbol depends on and what depends on it (blast radius before an edit). map: module overview + the most relevant symbols for the query.",
    ),
  query: z
    .string()
    .optional()
    .describe(
      "symbol/deps: a symbol name or fragment ('runUserTurn'). outline/deps: a file path or path fragment ('session/runner.ts'). map: optional focus words.",
    ),
})

export const EXPLORE_MAX_SYMBOLS = 5
export const EXPLORE_MAX_BODY_LINES = 60
const LIST_CAP = 12

function joinCapped(items: string[], cap = LIST_CAP): string {
  if (items.length === 0) return "none"
  const shown = items.slice(0, cap).join(", ")
  return items.length > cap ? `${shown}, … +${items.length - cap} more` : shown
}

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
  const callers = db.callers(def.name).map((ref) => `${ref.file} (${ref.count}×)`)
  const header = `${def.file}:${def.row + 1}  [${def.symbolKind} ${def.name}]`
  return `${header}\n${body}\ncallers: ${joinCapped(callers)}`
}

function resolveFile(db: GraphDb, query: string): { file?: string; candidates: string[] } {
  const files = db.findFiles(query.trim())
  if (files.length === 1) return { file: files[0], candidates: files }
  return { candidates: files }
}

function lineCount(cwd: string, file: string): number | undefined {
  try {
    return readFileSync(join(cwd, file), "utf8").split("\n").length
  } catch {
    return undefined
  }
}

function fileDeps(db: GraphDb, file: string) {
  const edges = db.fileEdges()
  const out = edges.filter((e) => e.from === file).map((e) => `${e.to} (${e.weight})`)
  const inbound = edges.filter((e) => e.to === file).map((e) => `${e.from} (${e.weight})`)
  return { out, inbound }
}

function renderOutline(db: GraphDb, cwd: string, query: string): string {
  const { file, candidates } = resolveFile(db, query)
  if (!file) {
    return candidates.length === 0
      ? `No indexed file matches "${query}". Use glob to find it (only source files in supported languages are indexed).`
      : `"${query}" matches ${candidates.length} files — be more specific:\n${candidates.map((c) => `  ${c}`).join("\n")}`
  }
  const defs = db.fileDefs(file)
  const lines = lineCount(cwd, file)
  const { out, inbound } = fileDeps(db, file)
  const body =
    defs.length === 0
      ? "  (no definitions indexed)"
      : defs
          .map(
            (d) =>
              `  ${d.symbolKind} ${d.name}  :${d.row + 1}${d.endRow > d.row ? `-${d.endRow + 1}` : ""}`,
          )
          .join("\n")
  return `${file}${lines ? ` (${lines} lines)` : ""}\n${body}\nimports from: ${joinCapped(out)}\nused by: ${joinCapped(inbound)}\n(read with offset/limit to fetch just the ranges you need)`
}

function renderDeps(db: GraphDb, query: string): string {
  const { file, candidates } = resolveFile(db, query)
  if (file && (query.includes("/") || query.includes("."))) {
    const { out, inbound } = fileDeps(db, file)
    const defined = db.fileDefs(file).map((d) => d.name)
    const affected = new Set(defined.flatMap((name) => db.callers(name).map((r) => r.file)))
    return [
      `${file}`,
      `depends on: ${joinCapped(out)}`,
      `depended on by: ${joinCapped(inbound)}`,
      `blast radius: editing its ${defined.length} definitions can affect ${affected.size} file(s)${affected.size > 0 ? ` — ${joinCapped([...affected])}` : ""}`,
    ].join("\n")
  }
  let defs = db.lookupDefs(query)
  if (defs.length === 0) defs = db.searchDefs(query)
  if (defs.length === 0) {
    return candidates.length > 1
      ? `"${query}" matches ${candidates.length} files — be more specific:\n${candidates.map((c) => `  ${c}`).join("\n")}`
      : `No symbol or file matches "${query}" in the code graph. Try grep.`
  }
  const sections = defs.slice(0, EXPLORE_MAX_SYMBOLS).map((def) => {
    const callers = db.callers(def.name)
    return `${def.symbolKind} ${def.name} — ${def.file}:${def.row + 1}\n  used by ${callers.length} file(s): ${joinCapped(callers.map((c) => `${c.file} (${c.count}×)`))}`
  })
  return sections.join("\n")
}

function renderMapOp(db: GraphDb, query: string): string {
  const analysis = analyzeProject(db)
  const overview = moduleOverview(db, 400, analysis)
  const words = query.split(/[^A-Za-z0-9_]+/).filter((w) => w.length >= 3)
  const skeleton = buildSkeleton(db, { mentionedIdents: words, budgetTokens: 600 })
  const parts = [
    overview,
    skeleton && `ranked symbols${words.length > 0 ? ` for "${query}"` : ""}:\n${skeleton}`,
  ]
  const text = parts.filter((p) => p).join("\n\n")
  return text === ""
    ? "The code graph is empty — no supported source files were indexed."
    : `${text}\n\n(full map with dependency graph: .butterfly/${PROJECT_MAP_FILE})`
}

/**
 * The code graph tool:
 *  - symbol: matching definition bodies plus their callers;
 *  - outline: a file's definitions with line ranges and imports/used-by;
 *  - deps: file- or symbol-level dependencies and blast radius;
 *  - map: module overview plus a query-focused ranked skeleton.
 * `refresh` re-syncs before answering so results reflect recent edits.
 */
export function createExploreTool(opts: {
  db: () => GraphDb | undefined
  cwd: string
  refresh?: () => Promise<void>
}): ToolDefinition<z.infer<typeof exploreInput>> {
  return {
    name: "explore",
    description:
      "Query the code graph instead of grepping and reading whole files. op=map for orientation in an unfamiliar area; op=outline before reading a large file (symbols + line ranges); op=symbol for definition bodies + callers; op=deps for what a change will affect.",
    inputSchema: exploreInput,
    async execute(input) {
      if (opts.refresh) await opts.refresh().catch(() => {})
      const db = opts.db()
      if (!db) {
        return { output: "Code graph not ready yet — use grep/read instead.", isError: true }
      }
      const op = input.op ?? "symbol"
      const query = (input.query ?? "").trim()
      if (op !== "map" && query === "") {
        return { output: `explore op=${op} needs a query.`, isError: true }
      }
      if (op === "outline") return { output: renderOutline(db, opts.cwd, query) }
      if (op === "deps") return { output: renderDeps(db, query) }
      if (op === "map") return { output: renderMapOp(db, query) }

      let matches = db.lookupDefs(query)
      if (matches.length === 0) matches = db.searchDefs(query)
      if (matches.length === 0) {
        // A path in the symbol slot is a common slip — answer it as an outline.
        if (query.includes("/") || /\.[a-z]{1,4}$/i.test(query)) {
          return { output: renderOutline(db, opts.cwd, query) }
        }
        return {
          output: `No symbols match "${query}" in the code graph. Try the grep tool for full-text search, or glob to find files.`,
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
