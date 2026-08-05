
const PROMPT_HEADING = "## ❯ "

export interface PagerDoc {
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

export function searchPagerLines(lines: string[], query: string): number[] {
  if (query === "") return []
  const needle = query.toLowerCase()
  const hits: number[] = []
  lines.forEach((line, i) => {
    if (line.toLowerCase().includes(needle)) hits.push(i)
  })
  return hits
}

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
