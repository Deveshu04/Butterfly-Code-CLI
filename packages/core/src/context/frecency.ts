import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative } from "node:path"
import type { ToolDefinition } from "../tool/registry"


export interface FrecencyEntry {
  path: string
  freq: number
  /** Epoch milliseconds. */
  lastOpen: number
}

export const FRECENCY_CAP = 1_000
const MS_PER_DAY = 86_400_000

export function frecencyStorePath(cwd: string): string {
  return join(cwd, ".butterfly", "frecency.ndjson")
}

export function frecencyScore(entry: FrecencyEntry, now: number): number {
  return entry.freq / (1 + (now - entry.lastOpen) / MS_PER_DAY)
}

export function loadFrecency(storePath: string): FrecencyEntry[] {
  let raw: string
  try {
    raw = readFileSync(storePath, "utf8")
  } catch {
    return []
  }
  const entries: FrecencyEntry[] = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "") continue
    try {
      const parsed = JSON.parse(trimmed) as Partial<FrecencyEntry>
      if (
        typeof parsed.path === "string" &&
        typeof parsed.freq === "number" &&
        typeof parsed.lastOpen === "number"
      ) {
        entries.push({ path: parsed.path, freq: parsed.freq, lastOpen: parsed.lastOpen })
      }
    } catch {
      // Corrupt line — skip it rather than fail the whole load.
    }
  }
  return entries
}

function writeFrecency(storePath: string, entries: FrecencyEntry[]): void {
  mkdirSync(dirname(storePath), { recursive: true })
  const body = entries.map((e) => JSON.stringify(e)).join("\n")
  writeFileSync(storePath, entries.length > 0 ? `${body}\n` : "")
}

export function touchFrecency(
  storePath: string,
  path: string,
  now: number = Date.now(),
): FrecencyEntry[] {
  const entries = loadFrecency(storePath)
  const existing = entries.find((e) => e.path === path)
  if (existing) {
    existing.freq += 1
    existing.lastOpen = now
  } else {
    entries.push({ path, freq: 1, lastOpen: now })
  }
  let capped = entries
  if (capped.length > FRECENCY_CAP) {
    capped = [...capped].sort((a, b) => b.lastOpen - a.lastOpen).slice(0, FRECENCY_CAP)
  }
  writeFrecency(storePath, capped)
  return capped
}

export function rankByFrecency(
  candidates: string[],
  entries: FrecencyEntry[],
  now: number = Date.now(),
): string[] {
  const scores = new Map(entries.map((e) => [e.path, frecencyScore(e, now)]))
  return candidates
    .map((path, index) => ({ path, index, score: scores.get(path) ?? 0 }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.path)
}

function toRelSlash(cwd: string, path: string): string {
  const rel = isAbsolute(path) ? relative(cwd, path) : path
  return rel.replaceAll("\\", "/")
}

export function withFrecencyTouch<I>(
  tool: ToolDefinition<I>,
  storePath: string,
  pathOf: (input: I) => string | undefined,
): ToolDefinition<I> {
  return {
    ...tool,
    async execute(input, ctx) {
      const outcome = await tool.execute(input, ctx)
      if (!outcome.isError) {
        const path = pathOf(input)
        if (path) {
          try {
            touchFrecency(storePath, toRelSlash(ctx.cwd, path))
          } catch {
            // Never fail the tool call over frecency bookkeeping.
          }
        }
      }
      return outcome
    },
  }
}
