/**
 * Strips terminal noise (escapes, progress frames, repeated lines) from bash
 * output before settle(), since many tools ignore NO_COLOR. Not applied to
 * file reads: the model must see bytes as they are on disk.
 */

// CSI (incl. SGR colors, cursor moves, erase), OSC (titles, hyperlinks —
// BEL or ST terminated), and the lone two-byte escapes.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching escape bytes is the point
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

/** Runs of identical lines longer than this collapse to one + a count. */
export const REPEAT_COLLAPSE_MIN = 3

export function stripAnsi(text: string): string {
  return text.includes("\x1b") ? text.replace(ANSI, "") : text
}

/**
 * Carriage-return overwrites (progress bars, spinners) resolve the way a
 * terminal would show them: only the text after the last bare \r on a line
 * survives. A CRLF line ending is just a line ending.
 */
export function resolveCarriageReturns(text: string): string {
  if (!text.includes("\r")) return text
  return text
    .split("\n")
    .map((line) => {
      const body = line.endsWith("\r") ? line.slice(0, -1) : line
      const last = body.lastIndexOf("\r")
      return last === -1 ? body : body.slice(last + 1)
    })
    .join("\n")
}

/** Collapse runs of ≥ REPEAT_COLLAPSE_MIN identical non-empty lines. */
export function collapseRepeats(text: string): string {
  const lines = text.split("\n")
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ""
    let run = 1
    while (i + run < lines.length && lines[i + run] === line) run += 1
    if (run >= REPEAT_COLLAPSE_MIN && line.trim() !== "") {
      out.push(line, `[... previous line repeated ${run - 1} more times]`)
    } else {
      for (let k = 0; k < run; k++) out.push(line)
    }
    i += run
  }
  return out.join("\n")
}

export function cleanCommandOutput(text: string): string {
  if (text === "") return text
  return collapseRepeats(resolveCarriageReturns(stripAnsi(text)))
}
