import { existsSync, readFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { SessionEvent } from "../session/events"


export const AGENTS_MD_FILENAME = "AGENTS.md"

export const AGENTS_MD_FRAGMENT_CAP_CHARS = 2_000

/** Total budget (chars) across every fragment loaded this session. */
export const AGENTS_MD_TOTAL_BUDGET_CHARS = 6_000

export interface AgentsMdFragment {
  /** Absolute path — dedup identity. */
  path: string
  /** cwd-relative, forward-slash path — display only. */
  relPath: string
  content: string
  truncated: boolean
}

export interface AgentsMdReconcileResult {
  /** Newly-discovered fragments to inject this reconcile, root->deep order. */
  fragments: AgentsMdFragment[]
  /** Absolute paths newly rejected by the total budget this reconcile. */
  skipped: string[]
  /** Set only when `skipped` is non-empty. */
  warning?: string
}

function toRelSlash(cwdAbs: string, absPath: string): string {
  return relative(cwdAbs, absPath).split(sep).join("/")
}

function toAbsPath(cwdAbs: string, raw: string): string {
  if (isAbsolute(raw)) return resolve(raw)
  return resolve(join(cwdAbs, raw.split("/").join(sep)))
}

function pathKey(absPath: string): string {
  return process.platform === "win32" ? absPath.toLowerCase() : absPath
}

function depthOf(absPath: string, cwdAbs: string): number {
  const rel = relative(cwdAbs, dirname(absPath))
  if (rel === "") return 0
  return rel.split(sep).filter(Boolean).length
}

/**
 * Every EXISTING AGENTS.md from `fileAbsPath`'s directory up to (and
 * including) `cwdAbs`, nearest-first. Files outside the repo root yield [].
 */
export function agentsMdAncestors(fileAbsPath: string, cwdAbs: string): string[] {
  const cwdReal = resolve(cwdAbs)
  const rel = relative(cwdReal, fileAbsPath)
  if (rel.startsWith("..") || isAbsolute(rel)) return []

  const chain: string[] = []
  let dir = dirname(fileAbsPath)
  for (let i = 0; i < 64; i++) {
    const candidate = join(dir, AGENTS_MD_FILENAME)
    if (existsSync(candidate)) chain.push(candidate)
    if (resolve(dir) === cwdReal) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return chain
}

const MENTION_PATH_LINE = /^--- @(.+?) ---$/gm

export function extractTouchedFiles(events: SessionEvent[], cwdAbs: string): string[] {
  const cwdReal = resolve(cwdAbs)
  const seen = new Set<string>()
  const out: string[] = []
  const add = (raw: string) => {
    const abs = toAbsPath(cwdReal, raw)
    const key = pathKey(abs)
    if (!seen.has(key)) {
      seen.add(key)
      out.push(abs)
    }
  }

  for (const event of events) {
    if (event.type === "tool.call" && (event.name === "read" || event.name === "edit")) {
      const input = event.input
      if (input && typeof input === "object" && "file_path" in input) {
        const fp = (input as Record<string, unknown>).file_path
        if (typeof fp === "string" && fp !== "") add(fp)
      }
    } else if (event.type === "message.user") {
      for (const match of event.text.matchAll(MENTION_PATH_LINE)) {
        const p = match[1]
        if (p) add(p)
      }
    }
  }
  return out
}

export function loadAgentsMdFragment(
  absPath: string,
  cwdAbs: string,
  capChars = AGENTS_MD_FRAGMENT_CAP_CHARS,
): AgentsMdFragment {
  const relPath = toRelSlash(resolve(cwdAbs), absPath)
  let raw: string
  try {
    raw = readFileSync(absPath, "utf8")
  } catch {
    return { path: absPath, relPath, content: "", truncated: false }
  }
  const truncated = raw.length > capChars
  const content = truncated ? `${raw.slice(0, capChars)}\n[truncated]` : raw
  return { path: absPath, relPath, content, truncated }
}

export function reconcileAgentsMd(
  events: SessionEvent[],
  cwdAbs: string,
  opts?: { fragmentCapChars?: number; totalBudgetChars?: number },
): AgentsMdReconcileResult {
  const cwdReal = resolve(cwdAbs)
  const fragmentCap = opts?.fragmentCapChars ?? AGENTS_MD_FRAGMENT_CAP_CHARS
  const totalBudget = opts?.totalBudgetChars ?? AGENTS_MD_TOTAL_BUDGET_CHARS

  const considered = new Set<string>()
  let priorTotal = 0
  for (const event of events) {
    if (event.type !== "context.fragment" || event.source !== "agents.md") continue
    for (const fragment of event.fragments) {
      const key = pathKey(fragment.path)
      if (!considered.has(key)) {
        considered.add(key)
        priorTotal += fragment.content.length
      }
    }
    for (const path of event.skipped ?? []) considered.add(pathKey(path))
  }

  const candidates = new Map<string, string>()
  const addCandidate = (path: string) => {
    const key = pathKey(path)
    if (!candidates.has(key)) candidates.set(key, path)
  }
  const root = join(cwdReal, AGENTS_MD_FILENAME)
  if (existsSync(root)) addCandidate(root)
  for (const file of extractTouchedFiles(events, cwdReal)) {
    for (const ancestor of agentsMdAncestors(file, cwdReal)) addCandidate(ancestor)
  }

  const fresh = [...candidates.entries()]
    .filter(([key]) => !considered.has(key))
    .map(([, path]) => path)
  if (fresh.length === 0) return { fragments: [], skipped: [] }

  const byNearestFirst = fresh.sort((a, b) => depthOf(b, cwdReal) - depthOf(a, cwdReal))

  const accepted: AgentsMdFragment[] = []
  const skipped: string[] = []
  let running = priorTotal
  for (const path of byNearestFirst) {
    const fragment = loadAgentsMdFragment(path, cwdReal, fragmentCap)
    if (running + fragment.content.length > totalBudget) {
      skipped.push(path)
      continue
    }
    running += fragment.content.length
    accepted.push(fragment)
  }

  accepted.sort((a, b) => depthOf(a.path, cwdReal) - depthOf(b.path, cwdReal))

  const warning =
    skipped.length > 0
      ? `AGENTS.md context budget (${totalBudget} chars) reached — skipped ${skipped.length} fragment(s): ${skipped
          .map((p) => toRelSlash(cwdReal, p))
          .join(", ")}`
      : undefined

  return { fragments: accepted, skipped, ...(warning !== undefined ? { warning } : {}) }
}

/** Renders loaded fragments into one appended, labelled transcript block. */
export function renderAgentsMdBlock(fragments: AgentsMdFragment[]): string {
  if (fragments.length === 0) return ""
  const sections = fragments.map((f) => `--- ${f.relPath} ---\n${f.content}`)
  return `[project guidance — nested AGENTS.md, ordered root to nearest; the nearest file wins]\n${sections.join("\n\n")}`
}
