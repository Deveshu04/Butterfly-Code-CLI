/** Display-side text hygiene. Journals always keep the raw text. */

export interface ThinkSplit {
  rest: string
  thinking: string
  open: boolean
}

export function splitThink(text: string): ThinkSplit {
  let thinking = ""
  const rest0 = text.replace(/<think>([\s\S]*?)<\/think>\s*/g, (_match, inner: string) => {
    thinking += inner
    return ""
  })
  const openIdx = rest0.indexOf("<think>")
  if (openIdx < 0) return { rest: rest0, thinking, open: false }
  thinking += (thinking !== "" ? "\n" : "") + rest0.slice(openIdx + "<think>".length)
  return { rest: rest0.slice(0, openIdx), thinking, open: true }
}

export function stripThink(text: string): string {
  return splitThink(text).rest
}

function previewLines(output: string, isError: boolean): { shown: string[]; hidden: number } {
  const lines = output.split("\n").filter((line) => line.trim() !== "")
  const keep = isError ? 5 : 2
  const shown = lines.slice(0, keep).map((line) => line.slice(0, 160))
  const hidden = lines.length - Math.min(lines.length, keep)
  return { shown, hidden }
}

export function formatToolResult(output: string, isError: boolean): string {
  const { shown, hidden } = previewLines(output, isError)
  const body = shown.map((line) => `  ${line}`)
  if (hidden > 0) body.push(`  … ${hidden} more line${hidden === 1 ? "" : "s"}`)
  return `${isError ? "✗" : "✓"} ${body.join("\n").trimStart()}`
}

export function formatCommandBody(output: string, isError: boolean): string {
  const { shown, hidden } = previewLines(output, isError)
  if (hidden > 0) shown.push(`… ${hidden} more line${hidden === 1 ? "" : "s"}`)
  return shown.join("\n")
}
