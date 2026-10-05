/**
 * Transcript pager (Ctrl+O): pure line/search/jump math, kept IO-free for
 * testing. app.tsx owns state and keys; ./pager-view owns presentation.
 */

/** Heading `exportSessionMarkdown` emits for a live user prompt; keep in sync.
 * Undone prompts get `## (undone) ❯ ` there, so jumps skip them. */
const PROMPT_HEADING = "## ❯ "

export interface PagerDoc {
  /** Raw journal export (not the projected view), so search reaches pruned
   * and compacted turns. */
  source: string
  /** source.split("\n"), line-indexed for search + prompt jumps. */
  lines: string[]
  /** Line indices where a user prompt starts (a "## ❯ " heading). */
  promptLines: number[]
}

export function buildPagerDoc(source: string): PagerDoc {
  const lines = source.split("\n")
  const promptLines: number[] = []
  lines.forEach((line, i) => {
    if (line.startsWith(PROMPT_HEADING)) promptLines.push(i)
  })
  return { source, lines, promptLines }
}

/** Case-insensitive substring search over lines; an empty query matches nothing. */
export function searchPagerLines(lines: string[], query: string): number[] {
  if (query === "") return []
  const needle = query.toLowerCase()
  const hits: number[] = []
  lines.forEach((line, i) => {
    if (line.toLowerCase().includes(needle)) hits.push(i)
  })
  return hits
}

/**
 * Next/prev entry in a sorted line-index list relative to `line`, wrapping at
 * both ends. Used for match (n/N) and prompt ({/}) navigation. -1 if empty.
 */
export function stepLine(indices: number[], line: number, direction: 1 | -1): number {
  if (indices.length === 0) return -1
  if (direction === 1) {
    return indices.find((i) => i > line) ?? indices[0] ?? -1
  }
  for (let k = indices.length - 1; k >= 0; k--) {
    const i = indices[k]
    if (i !== undefined && i < line) return i
  }
  return indices[indices.length - 1] ?? -1
}
