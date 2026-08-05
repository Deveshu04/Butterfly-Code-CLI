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

interface Line {
  start: number
  end: number
  trimmed: string
}

function toLines(content: string): Line[] {
  const lines: Line[] = []
  let offset = 0
  for (const raw of content.split("\n")) {
    lines.push({ start: offset, end: offset + raw.length, trimmed: raw.trim() })
    offset += raw.length + 1
  }
  return lines
}

/** Find the unique region whose trimmed lines equal the search's trimmed lines. */
function findTrimmedRegion(content: string, search: string): { start: number; end: number } | null {
  const contentLines = toLines(content)
  const searchLines = search.split("\n").map((l) => l.trim())
  const span = searchLines.length
  const matches: { start: number; end: number }[] = []
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
      if (first && last) matches.push({ start: first.start, end: last.end })
    }
  }
  return matches.length === 1 ? (matches[0] ?? null) : null
}

export function applyEdit(
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
    return {
      ok: false,
      reason: "ambiguous",
      message: `Search text matches ${count} locations. Include more surrounding lines to make it unique, or set replaceAll: true to replace every occurrence.`,
    }
  }

  const region = findTrimmedRegion(content, oldString)
  if (region) {
    const next = content.slice(0, region.start) + newString + content.slice(region.end)
    return { ok: true, content: next, replacements: 1 }
  }

  return {
    ok: false,
    reason: "not_found",
    message:
      "Search text not found in file. Re-read the file — its content may have changed — and copy the target text exactly, including indentation.",
  }
}
