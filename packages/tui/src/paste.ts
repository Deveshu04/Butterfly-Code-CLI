
/** Pastes at or under this size stay inline as plain text. */
export const PASTE_CHIP_CHAR_THRESHOLD = 800
export const PASTE_CHIP_LINE_THRESHOLD = 2
export const PASTE_RATE_HEURISTIC_CHARS = 100

export const NEWLINE_MARKER = "⏎"

/** Matches one paste-chip placeholder anywhere in text (global). */
const CHIP_PATTERN = /\[Pasted #(\d+) \+\d+ lines\]/g
/** Same pattern, anchored to the END of a string (for atomic backspace). */
const TRAILING_CHIP_PATTERN = /\[Pasted #(\d+) \+\d+ lines\]$/

export function lineCount(text: string): number {
  return text.split("\n").length
}

export function shouldChip(text: string): boolean {
  return text.length > PASTE_CHIP_CHAR_THRESHOLD || lineCount(text) > PASTE_CHIP_LINE_THRESHOLD
}

export function chipLabel(n: number, lines: number): string {
  return `[Pasted #${n} +${lines} lines]`
}

export interface AddChipResult {
  /** `draft` with the new chip label appended. */
  draftWithChip: string
  payloads: ReadonlyMap<number, string>
  nextChipNumber: number
}

export function addPasteChip(
  draft: string,
  pastedText: string,
  payloads: ReadonlyMap<number, string>,
  nextChipNumber: number,
): AddChipResult {
  const n = nextChipNumber
  const label = chipLabel(n, lineCount(pastedText))
  const updated = new Map(payloads)
  updated.set(n, pastedText)
  return { draftWithChip: draft + label, payloads: updated, nextChipNumber: n + 1 }
}

export function endsWithChip(text: string): { label: string; n: number } | null {
  const m = text.match(TRAILING_CHIP_PATTERN)
  if (!m) return null
  const label = m[0]
  const numStr = m[1]
  if (numStr === undefined) return null
  return { label, n: Number(numStr) }
}

export interface RemoveChipResult {
  /** `draft` with the trailing chip label removed. */
  draft: string
  payloads: ReadonlyMap<number, string>
}

export function removeTrailingChip(
  draft: string,
  payloads: ReadonlyMap<number, string>,
): RemoveChipResult | null {
  const chip = endsWithChip(draft)
  if (!chip) return null
  const remaining = draft.slice(0, -chip.label.length)
  const updated = new Map(payloads)
  if (!remaining.includes(chip.label)) updated.delete(chip.n)
  return { draft: remaining, payloads: updated }
}

export function expandChips(text: string, payloads: ReadonlyMap<number, string>): string {
  return text.replace(CHIP_PATTERN, (whole, numStr: string) => {
    const payload = payloads.get(Number(numStr))
    return payload ?? whole
  })
}

export function expandComposerText(text: string, payloads: ReadonlyMap<number, string>): string {
  return expandChips(text, payloads).replaceAll(NEWLINE_MARKER, "\n")
}

export function toComposerDraft(text: string): string {
  return text.replace(/\r\n|\r|\n/g, NEWLINE_MARKER)
}

export function unreferencedChips(text: string, payloads: ReadonlyMap<number, string>): number[] {
  if (payloads.size === 0) return []
  const referenced = new Set<number>()
  for (const match of text.matchAll(CHIP_PATTERN)) {
    const numStr = match[1]
    if (numStr !== undefined) referenced.add(Number(numStr))
  }
  return [...payloads.keys()].filter((n) => !referenced.has(n)).sort((a, b) => a - b)
}

export function insertedSpan(previous: string, value: string): string {
  if (value.length <= previous.length) return ""
  const maxPrefix = Math.min(previous.length, value.length)
  let prefix = 0
  while (prefix < maxPrefix && previous[prefix] === value[prefix]) prefix++
  const maxSuffix = Math.min(previous.length - prefix, value.length - prefix)
  let suffix = 0
  while (
    suffix < maxSuffix &&
    previous[previous.length - 1 - suffix] === value[value.length - 1 - suffix]
  ) {
    suffix++
  }
  return value.slice(prefix, value.length - suffix)
}
