import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { estimateTokens } from "../context/tokens"
import type { DefRow, FileEdge, GraphDb } from "./db"
import { languageForPath } from "./languages"
import { rankFiles } from "./rank"

/**
 * The project map, derived from graph.db (the markdown file is only a view).
 * `renderProjectMap` writes `.butterfly/project-map.md` for people;
 * `moduleOverview` is a short module summary for the model's first turn.
 */

export const PROJECT_MAP_FILE = "project-map.md"
const MAX_MODULES = 30

export interface ModuleInfo {
  name: string
  files: string[]
  symbols: number
  dependsOn: Map<string, number>
  usedBy: Map<string, number>
  rank: number
}

export interface ProjectAnalysis {
  modules: ModuleInfo[]
  fileRank: Map<string, number>
  edges: FileEdge[]
  moduleOf: (file: string) => string
  languages: Map<string, number>
  totalSymbols: number
}

function dirSegments(file: string): string[] {
  const parts = file.split("/")
  parts.pop()
  return parts
}

/** Deepest directory depth at which the repo still splits into ≤ MAX_MODULES groups. */
function chooseDepth(files: string[]): number {
  const maxDepth = Math.max(0, ...files.map((f) => dirSegments(f).length))
  for (let depth = maxDepth; depth >= 1; depth--) {
    const groups = new Set(files.map((f) => dirSegments(f).slice(0, depth).join("/") || "."))
    if (groups.size <= MAX_MODULES) return depth
  }
  return 1
}

export function analyzeProject(db: GraphDb): ProjectAnalysis {
  const files = db.allFiles()
  const depth = chooseDepth(files)
  const moduleOf = (file: string) => dirSegments(file).slice(0, depth).join("/") || "."
  const fileRank = rankFiles(db)
  const edges = db.fileEdges()
  const defs = db.defs()

  const modules = new Map<string, ModuleInfo>()
  const get = (name: string) => {
    let info = modules.get(name)
    if (!info) {
      info = { name, files: [], symbols: 0, dependsOn: new Map(), usedBy: new Map(), rank: 0 }
      modules.set(name, info)
    }
    return info
  }
  const languages = new Map<string, number>()
  for (const file of files) {
    const info = get(moduleOf(file))
    info.files.push(file)
    info.rank += fileRank.get(file) ?? 0
    const lang = languageForPath(file)?.id ?? "other"
    languages.set(lang, (languages.get(lang) ?? 0) + 1)
  }
  for (const def of defs) get(moduleOf(def.file)).symbols += 1
  for (const edge of edges) {
    const from = moduleOf(edge.from)
    const to = moduleOf(edge.to)
    if (from === to) continue
    get(from).dependsOn.set(to, (get(from).dependsOn.get(to) ?? 0) + edge.weight)
    get(to).usedBy.set(from, (get(to).usedBy.get(from) ?? 0) + edge.weight)
  }

  return {
    modules: [...modules.values()].sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name)),
    fileRank,
    edges,
    moduleOf,
    languages,
    totalSymbols: defs.length,
  }
}

function topKeys(map: Map<string, number>, n: number): string[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([key]) => key)
}

/** Last path segment(s) — enough to tell modules apart in a dense line. */
function shortName(module: string, all: string[]): string {
  const parts = module.split("/")
  for (let n = 1; n <= parts.length; n++) {
    const tail = parts.slice(-n).join("/")
    if (all.filter((m) => m === tail || m.endsWith(`/${tail}`)).length <= 1) return tail
  }
  return module
}

/**
 * Compact module overview for the model's first turn: one line per module,
 * most central first, with its heaviest dependencies — clipped to budget.
 * Empty when the repo has a single module (the skeleton already says it all).
 */
export function moduleOverview(
  db: GraphDb,
  budgetTokens = 250,
  analysis?: ProjectAnalysis,
): string {
  const a = analysis ?? analyzeProject(db)
  if (a.modules.length < 2) return ""
  const names = a.modules.map((m) => m.name)
  const lines: string[] = []
  for (const module of a.modules) {
    const deps = topKeys(module.dependsOn, 4).map((d) => shortName(d, names))
    const line = `  ${module.name} (${module.files.length} files)${deps.length > 0 ? ` → ${deps.join(", ")}` : ""}`
    if (estimateTokens([...lines, line].join("\n")) > budgetTokens) break
    lines.push(line)
  }
  const hidden = a.modules.length - lines.length
  return `modules, most central first (→ = depends on):\n${lines.join("\n")}${hidden > 0 ? `\n  … ${hidden} more (see .butterfly/${PROJECT_MAP_FILE})` : ""}`
}

function mermaidId(index: number): string {
  return `m${index}`
}

function hubSymbols(db: GraphDb, n: number): { def: DefRow; files: number }[] {
  const defs = db.defs()
  const byName = new Map<string, DefRow[]>()
  for (const def of defs) byName.set(def.name, [...(byName.get(def.name) ?? []), def])
  const fanIn = new Map<string, Set<string>>()
  for (const ref of db.refs()) {
    const owners = byName.get(ref.name)
    if (!owners || owners.length > 3 || ref.name.length < 4) continue
    if (owners.some((o) => o.file === ref.file)) continue
    const set = fanIn.get(ref.name) ?? new Set<string>()
    set.add(ref.file)
    fanIn.set(ref.name, set)
  }
  return [...fanIn.entries()]
    .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
    .slice(0, n)
    .flatMap(([name, set]) => {
      const def = byName.get(name)?.[0]
      return def ? [{ def, files: set.size }] : []
    })
}

/** The full human-facing map (markdown + Mermaid). */
export function renderProjectMap(db: GraphDb, now: Date = new Date()): string {
  const a = analyzeProject(db)
  const stats = db.stats()
  const names = a.modules.map((m) => m.name)
  const langs = topKeys(a.languages, 8)
    .map((lang) => `${lang} ${a.languages.get(lang)}`)
    .join(", ")
  const out: string[] = [
    "# Project map",
    "",
    `> Auto-generated by butterfly from the code graph (\`.butterfly/graph.db\`) — ${now.toISOString().slice(0, 16).replace("T", " ")} UTC.`,
    "> Rebuilt whenever the code changes; safe to delete. The agent reads it via `explore op=map`.",
    "",
    `**${stats.files} files · ${stats.symbols} symbols · ${a.edges.length} file dependencies** — ${langs || "no indexed languages"}`,
    "",
  ]

  if (a.modules.length > 0) {
    out.push("## Modules (most central first)", "")
    out.push("| module | files | symbols | depends on | used by |", "|---|---:|---:|---|---|")
    for (const m of a.modules) {
      const deps =
        topKeys(m.dependsOn, 4)
          .map((d) => shortName(d, names))
          .join(", ") || "—"
      const users =
        topKeys(m.usedBy, 4)
          .map((d) => shortName(d, names))
          .join(", ") || "—"
      out.push(`| \`${m.name}\` | ${m.files.length} | ${m.symbols} | ${deps} | ${users} |`)
    }
    out.push("")
  }

  const moduleEdges: { from: number; to: number; weight: number }[] = []
  a.modules.forEach((m, i) => {
    for (const [dep, weight] of m.dependsOn) {
      const j = names.indexOf(dep)
      if (j >= 0) moduleEdges.push({ from: i, to: j, weight })
    }
  })
  if (moduleEdges.length > 0) {
    const shown = moduleEdges.sort((x, y) => y.weight - x.weight).slice(0, 40)
    const used = new Set(shown.flatMap((e) => [e.from, e.to]))
    out.push("## Module dependency graph", "", "```mermaid", "graph LR")
    for (const i of [...used].sort((x, y) => x - y)) {
      out.push(`  ${mermaidId(i)}["${shortName(names[i] ?? "", names)}"]`)
    }
    for (const e of shown) out.push(`  ${mermaidId(e.from)} --> ${mermaidId(e.to)}`)
    out.push("```", "")
    if (moduleEdges.length > shown.length) {
      out.push(`_${moduleEdges.length - shown.length} lighter edges omitted._`, "")
    }
  }

  const central = [...a.fileRank.entries()].sort((x, y) => y[1] - x[1]).slice(0, 15)
  if (central.length > 0) {
    out.push("## Most central files (PageRank over references)", "")
    central.forEach(([file], i) => {
      const defs = db
        .fileDefs(file)
        .slice(0, 6)
        .map((d) => `\`${d.name}\``)
        .join(", ")
      out.push(`${i + 1}. \`${file}\`${defs ? ` — ${defs}` : ""}`)
    })
    out.push("")
  }

  const hubs = hubSymbols(db, 15)
  if (hubs.length > 0) {
    out.push("## Hub symbols (referenced from the most files)", "")
    for (const { def, files } of hubs) {
      out.push(
        `- \`${def.name}\` (${def.symbolKind}) — \`${def.file}:${def.row + 1}\` — used in ${files} files`,
      )
    }
    out.push("")
  }
  return out.join("\n")
}

/** Atomic write (tmp + rename) so a reader never sees half a map. */
export function writeProjectMap(cwd: string, db: GraphDb, now?: Date): string {
  const path = join(cwd, ".butterfly", PROJECT_MAP_FILE)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, renderProjectMap(db, now))
  renameSync(tmp, path)
  return path
}
