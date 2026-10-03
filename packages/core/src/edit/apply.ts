export type EditResult =
  | { ok: true; content: string; replacements: number }
  | { ok: false; reason: "not_found" | "ambiguous" | "no_change"; message: string }

export interface EditOptions {
  replaceAll?: boolean
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

/** 1-based line numbers of every occurrence — for the ambiguity message. */
function occurrenceLines(haystack: string, needle: string, max = 8): number[] {
  const lines: number[] = []
  let index = haystack.indexOf(needle)
  while (index !== -1 && lines.length < max) {
    lines.push(haystack.slice(0, index).split("\n").length)
    index = haystack.indexOf(needle, index + needle.length)
  }
  return lines
}

interface Line {
  start: number
  end: number
  raw: string
  trimmed: string
}

function toLines(content: string): Line[] {
  const lines: Line[] = []
  let offset = 0
  for (const raw of content.split("\n")) {
    lines.push({ start: offset, end: offset + raw.length, raw, trimmed: raw.trim() })
    offset += raw.length + 1
  }
  return lines
}

function leadingWhitespace(line: string): string {
  return line.slice(0, line.length - line.trimStart().length)
}

interface Region {
  start: number
  end: number
  /** The file lines the search's lines were matched against, in order. */
  matched: string[]
}

/** Find the unique region whose trimmed lines equal the search's trimmed lines. */
function findTrimmedRegion(content: string, search: string): Region | null {
  const contentLines = toLines(content)
  const searchLines = search.split("\n").map((l) => l.trim())
  const span = searchLines.length
  const matches: Region[] = []
  for (let i = 0; i + span <= contentLines.length; i++) {
    let hit = true
    for (let j = 0; j < span; j++) {
      if (contentLines[i + j]?.trimmed !== searchLines[j]) {
        hit = false
        break
      }
    }
    if (hit) {
      const first = contentLines[i]
      const last = contentLines[i + span - 1]
      if (first && last) {
        const matched = contentLines.slice(i, i + span).map((line) => line.raw)
        matches.push({ start: first.start, end: last.end, matched })
      }
    }
  }
  return matches.length === 1 ? (matches[0] ?? null) : null
}

function reindent(searchLines: string[], matched: string[], replacement: string): string {
  const map = new Map<string, string>()
  for (let j = 0; j < searchLines.length; j++) {
    const searchLine = searchLines[j] ?? ""
    const fileLine = matched[j] ?? ""
    if (searchLine.trim() === "") continue
    const from = leadingWhitespace(searchLine)
    const to = leadingWhitespace(fileLine)
    const known = map.get(from)
    if (known !== undefined && known !== to)
      return reindentByPosition(searchLines, matched, replacement)
    map.set(from, to)
  }
  if ([...map].every(([from, to]) => from === to)) return replacement
  const keys = [...map.keys()].sort((a, b) => b.length - a.length)
  return replacement
    .split("\n")
    .map((line) => {
      if (line.trim() === "") return line
      const lead = leadingWhitespace(line)
      const key = keys.find((k) => lead.startsWith(k))
      if (key === undefined) return line
      return `${map.get(key)}${line.slice(key.length)}`
    })
    .join("\n")
}

function reindentByPosition(searchLines: string[], matched: string[], replacement: string): string {
  const lines = replacement.split("\n")
  if (lines.length !== searchLines.length) return replacement
  return lines
    .map((line, k) => {
      const searchLine = searchLines[k] ?? ""
      if (line.trim() === "" || leadingWhitespace(line) !== leadingWhitespace(searchLine))
        return line
      return `${leadingWhitespace(matched[k] ?? "")}${line.trimStart()}`
    })
    .join("\n")
}

/** Character-bigram Dice similarity of two trimmed lines, 0..1. */
function lineSimilarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const grams = new Map<string, number>()
  for (let i = 0; i < a.length - 1; i++) {
    const gram = a.slice(i, i + 2)
    grams.set(gram, (grams.get(gram) ?? 0) + 1)
  }
  let overlap = 0
  for (let i = 0; i < b.length - 1; i++) {
    const gram = b.slice(i, i + 2)
    const left = grams.get(gram) ?? 0
    if (left > 0) {
      overlap += 1
      grams.set(gram, left - 1)
    }
  }
  return (2 * overlap) / (a.length - 1 + (b.length - 1))
}

const HINT_MAX_FILE_LINES = 20_000
const HINT_MAX_SPAN = 40
const HINT_MAX_SHOWN = 12
const HINT_MAX_LINE_CHARS = 200
const HINT_MIN_SCORE = 0.5

export function closestMatchHint(content: string, search: string): string | undefined {
  const fileLines = content.split("\n")
  const searchLines = search
    .split("\n")
    .map((line) => line.trim())
    .filter((line, index, all) => line !== "" || (index > 0 && index < all.length - 1))
  const span = searchLines.length
  if (span === 0 || span > HINT_MAX_SPAN || fileLines.length > HINT_MAX_FILE_LINES) return undefined
  const trimmed = fileLines.map((line) => line.trim())
  let bestScore = 0
  let bestStart = -1
  for (let i = 0; i + span <= trimmed.length; i++) {
    let score = 0
    for (let j = 0; j < span; j++)
      score += lineSimilarity(searchLines[j] ?? "", trimmed[i + j] ?? "")
    if (score > bestScore) {
      bestScore = score
      bestStart = i
    }
  }
  if (bestStart < 0 || bestScore / span < HINT_MIN_SCORE) return undefined
  const shown = fileLines.slice(bestStart, bestStart + Math.min(span, HINT_MAX_SHOWN))
  const body = shown
    .map((line, i) => {
      const text =
        line.length > HINT_MAX_LINE_CHARS ? `${line.slice(0, HINT_MAX_LINE_CHARS)}…` : line
      return `${bestStart + i + 1}\t${text}`
    })
    .join("\n")
  const more = span > HINT_MAX_SHOWN ? `\n[… ${span - HINT_MAX_SHOWN} more lines]` : ""
  const last = bestStart + span
  return `Closest match in the file (lines ${bestStart + 1}-${last}, ${Math.round((bestScore / span) * 100)}% similar):\n${body}${more}`
}

/** True when every newline in `content` is part of a CRLF pair. */
function isCrlf(content: string): boolean {
  const crlf = content.split("\r\n").length - 1
  if (crlf === 0) return false
  return crlf === content.split("\n").length - 1
}

export function applyEdit(
  content: string,
  oldString: string,
  newString: string,
  opts?: EditOptions,
): EditResult {
  if (isCrlf(content)) {
    const toLf = (text: string) => text.replaceAll("\r\n", "\n")
    const result = applyEditLf(toLf(content), toLf(oldString), toLf(newString), opts)
    if (!result.ok) return result
    return { ...result, content: result.content.replaceAll("\n", "\r\n") }
  }
  return applyEditLf(content, oldString, newString, opts)
}

function applyEditLf(
  content: string,
  oldString: string,
  newString: string,
  opts?: EditOptions,
): EditResult {
  if (oldString === newString) {
    return {
      ok: false,
      reason: "no_change",
      message:
        "Search and replacement are identical — the file already contains exactly this content. Do not edit again; if the goal is achieved, verify with read and finish with a summary.",
    }
  }

  if (oldString === "") {
    if (content === "") return { ok: true, content: newString, replacements: 1 }
    return {
      ok: false,
      reason: "not_found",
      message:
        "Empty search text is only valid when the file is empty or new. Provide the exact text to replace.",
    }
  }

  const count = countOccurrences(content, oldString)

  if (count === 1) {
    return { ok: true, content: content.replace(oldString, () => newString), replacements: 1 }
  }

  if (count > 1) {
    if (opts?.replaceAll) {
      return { ok: true, content: content.split(oldString).join(newString), replacements: count }
    }
    const where = occurrenceLines(content, oldString)
    return {
      ok: false,
      reason: "ambiguous",
      message: `Search text matches ${count} locations (lines ${where.join(", ")}${count > where.length ? ", …" : ""}). Include more surrounding lines to make it unique, or set replaceAll: true to replace every occurrence.`,
    }
  }

  const region = findTrimmedRegion(content, oldString)
  if (region) {
    const replacement = reindent(oldString.split("\n"), region.matched, newString)
    const next = content.slice(0, region.start) + replacement + content.slice(region.end)
    return { ok: true, content: next, replacements: 1 }
  }

  const hint = closestMatchHint(content, oldString)
  return {
    ok: false,
    reason: "not_found",
    message: hint
      ? `Search text not found in file. ${hint}\nCopy the target text exactly from these lines (without the line-number prefix) and retry.`
      : "Search text not found in file. Re-read the file — its content may have changed — and copy the target text exactly, including indentation.",
  }
}
