import type { DefRow, GraphDb } from "./db"

export interface RankOptions {
  chatFiles?: string[]
  mentionedIdents?: string[]
}

const DAMPING = 0.85
const ITERATIONS = 30

function isWellNamed(name: string): boolean {
  return name.length >= 8 && /[a-zA-Z]/.test(name)
}

export function rankFiles(db: GraphDb, opts?: RankOptions): Map<string, number> {
  const defs = db.defs()
  const refs = db.refs()
  const chat = new Set(opts?.chatFiles ?? [])
  const mentioned = new Set(opts?.mentionedIdents ?? [])

  const files = [...new Set([...defs.map((d) => d.file), ...refs.map((r) => r.file)])]
  if (files.length === 0) return new Map()

  const definersByName = new Map<string, string[]>()
  for (const def of defs) {
    const list = definersByName.get(def.name) ?? []
    list.push(def.file)
    definersByName.set(def.name, list)
  }

  // edges[src][dst] = weight
  const edges = new Map<string, Map<string, number>>()
  const addEdge = (src: string, dst: string, weight: number) => {
    const out = edges.get(src) ?? new Map<string, number>()
    out.set(dst, (out.get(dst) ?? 0) + weight)
    edges.set(src, out)
  }

  for (const ref of refs) {
    const definers = definersByName.get(ref.name)
    if (!definers || definers.length === 0) continue
    let weight = Math.sqrt(ref.count)
    if (mentioned.has(ref.name)) weight *= 10
    if (isWellNamed(ref.name)) weight *= 10
    if (ref.name.startsWith("_")) weight *= 0.1
    if (new Set(definers).size > 5) weight *= 0.1
    if (chat.has(ref.file)) weight *= 50
    for (const definer of definers) {
      if (definer !== ref.file) addEdge(ref.file, definer, weight / definers.length)
    }
  }

  // Personalization: uniform base, heavy boost for chat files.
  const personalization = new Map<string, number>()
  let personalTotal = 0
  for (const file of files) {
    const p = chat.has(file) ? 50 : 1
    personalization.set(file, p)
    personalTotal += p
  }
  for (const [file, p] of personalization) personalization.set(file, p / personalTotal)

  const outSums = new Map<string, number>()
  for (const [src, out] of edges) {
    outSums.set(
      src,
      [...out.values()].reduce((a, b) => a + b, 0),
    )
  }

  let rank = new Map<string, number>(files.map((f) => [f, 1 / files.length]))
  for (let i = 0; i < ITERATIONS; i++) {
    const next = new Map<string, number>()
    let danglingMass = 0
    for (const file of files) {
      const out = outSums.get(file) ?? 0
      if (out === 0) danglingMass += rank.get(file) ?? 0
    }
    for (const file of files) {
      const base = (1 - DAMPING + DAMPING * danglingMass) * (personalization.get(file) ?? 0)
      next.set(file, base)
    }
    for (const [src, out] of edges) {
      const srcRank = rank.get(src) ?? 0
      const total = outSums.get(src) ?? 1
      for (const [dst, weight] of out) {
        next.set(dst, (next.get(dst) ?? 0) + DAMPING * srcRank * (weight / total))
      }
    }
    rank = next
  }
  return rank
}

/** Definitions ordered by redistributed file rank (best context first). */
export function rankedDefinitions(db: GraphDb, opts?: RankOptions): DefRow[] {
  const fileRank = rankFiles(db, opts)
  const mentioned = new Set(opts?.mentionedIdents ?? [])

  const inbound = new Map<string, number>()
  const defFiles = new Map<string, Set<string>>()
  for (const def of db.defs()) {
    const set = defFiles.get(def.name) ?? new Set()
    set.add(def.file)
    defFiles.set(def.name, set)
  }
  for (const ref of db.refs()) {
    if (!defFiles.has(ref.name)) continue
    if (defFiles.get(ref.name)?.has(ref.file) && defFiles.get(ref.name)?.size === 1) {
      // ref only from the defining file itself — weak signal, still counts.
    }
    inbound.set(ref.name, (inbound.get(ref.name) ?? 0) + ref.count)
  }

  const score = (def: DefRow): number => {
    let s = (fileRank.get(def.file) ?? 0) * (1 + (inbound.get(def.name) ?? 0))
    if (mentioned.has(def.name)) s *= 10
    if (def.name.startsWith("_")) s *= 0.1
    return s
  }

  return db
    .defs()
    .map((def) => ({ def, s: score(def) }))
    .sort((a, b) => b.s - a.s || a.def.file.localeCompare(b.def.file) || a.def.row - b.def.row)
    .map((entry) => entry.def)
}
