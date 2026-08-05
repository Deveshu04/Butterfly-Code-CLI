
const BUTTERFLY = [
  "██████╗ ██╗   ██╗████████╗████████╗███████╗██████╗ ███████╗██╗  ██╗   ██╗",
  "██╔══██╗██║   ██║╚══██╔══╝╚══██╔══╝██╔════╝██╔══██╗██╔════╝██║  ╚██╗ ██╔╝",
  "██████╔╝██║   ██║   ██║      ██║   █████╗  ██████╔╝█████╗  ██║   ╚████╔╝ ",
  "██╔══██╗██║   ██║   ██║      ██║   ██╔══╝  ██╔══██╗██╔══╝  ██║    ╚██╔╝  ",
  "██████╔╝╚██████╔╝   ██║      ██║   ███████╗██║  ██║██║     ███████╗██║   ",
  "╚═════╝  ╚═════╝    ╚═╝      ╚═╝   ╚══════╝╚═╝  ╚═╝╚═╝     ╚══════╝╚═╝   ",
]

const CODE = [
  " ██████╗ ██████╗ ██████╗ ███████╗",
  "██╔════╝██╔═══██╗██╔══██╗██╔════╝",
  "██║     ██║   ██║██║  ██║█████╗  ",
  "██║     ██║   ██║██║  ██║██╔══╝  ",
  "╚██████╗╚██████╔╝██████╔╝███████╗",
  " ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝",
]

function padded(rows: string[]): string[] {
  const width = Math.max(...rows.map((row) => row.length))
  return rows.map((row) => row.padEnd(width))
}

export const WORDMARK_ROWS = 6
const GAP = "  "

export interface Wordmark {
  /** "BUTTERFLY" rows (rendered muted). */
  left: string[]
  /** "CODE" rows (rendered bold). */
  right: string[]
  /** Width of one combined single-line row. */
  singleWidth: number
  /** Width of the wider word (stacked mode). */
  stackedWidth: number
}

export function renderWordmark(): Wordmark {
  const left = padded(BUTTERFLY)
  const right = padded(CODE)
  return {
    left,
    right,
    singleWidth: (left[0]?.length ?? 0) + GAP.length + (right[0]?.length ?? 0),
    stackedWidth: Math.max(left[0]?.length ?? 0, right[0]?.length ?? 0),
  }
}

export type WordmarkMode = "single" | "stacked" | "plain"

export function wordmarkMode(columns: number): WordmarkMode {
  const mark = renderWordmark()
  if (columns >= mark.singleWidth + 4) return "single"
  if (columns >= mark.stackedWidth + 4) return "stacked"
  return "plain"
}

export function fitsWordmark(columns: number): boolean {
  return wordmarkMode(columns) !== "plain"
}
