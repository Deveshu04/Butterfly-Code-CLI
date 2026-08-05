/** Display-side text hygiene. Journals always keep the raw text. */

export function stripThink(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>\s*/g, "")
  const open = out.indexOf("<think>")
  if (open >= 0) out = out.slice(0, open)
  return out
}

export function formatToolResult(output: string, isError: boolean): string {
  const lines = output.split("\n").filter((line) => line.trim() !== "")
  const keep = isError ? 5 : 2
  const shown = lines.slice(0, keep).map((line) => `  ${line.slice(0, 160)}`)
  const hidden = lines.length - Math.min(lines.length, keep)
  if (hidden > 0) shown.push(`  … ${hidden} more line${hidden === 1 ? "" : "s"}`)
  return `${isError ? "✗" : "✓"} ${shown.join("\n").trimStart()}`
}
