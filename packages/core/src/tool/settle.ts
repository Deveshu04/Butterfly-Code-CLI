export interface SettleOptions {
  /** Hard cap on what the model sees. Capture (UI/journal) keeps the full text. */
  maxChars?: number
  /** Fraction of the budget given to the head; the rest goes to the tail. */
  headRatio?: number
}

export interface Settled {
  text: string
  truncated: boolean
  originalChars: number
  originalLines: number
}

export const DEFAULT_MODEL_OUTPUT_CHARS = 30_000

function countLines(raw: string): number {
  if (raw === "") return 0
  return raw.split("\n").length - (raw.endsWith("\n") ? 1 : 0)
}

/**
 * Every tool's output passes through here before the model sees it.
 * Head/tail elision keeps the first errors and the final summary.
 */
export function settle(raw: string, opts?: SettleOptions): Settled {
  const maxChars = opts?.maxChars ?? DEFAULT_MODEL_OUTPUT_CHARS
  const headRatio = opts?.headRatio ?? 0.6
  const originalChars = raw.length
  const originalLines = countLines(raw)

  if (originalChars <= maxChars) {
    return { text: raw, truncated: false, originalChars, originalLines }
  }

  // Size the marker for the worst case (all chars elided) so the final text
  // can only come in at or under the budget.
  const worstMarker = `\n[... ${originalChars} chars elided ...]\n`
  const budget = Math.max(0, maxChars - worstMarker.length)
  const headLength = Math.floor(budget * headRatio)
  const tailLength = budget - headLength
  const elidedCount = originalChars - headLength - tailLength
  const marker = `\n[... ${elidedCount} chars elided ...]\n`

  const head = raw.slice(0, headLength)
  const tail = tailLength > 0 ? raw.slice(-tailLength) : ""
  return {
    text: `${head}${marker}${tail}`,
    truncated: true,
    originalChars,
    originalLines,
  }
}
