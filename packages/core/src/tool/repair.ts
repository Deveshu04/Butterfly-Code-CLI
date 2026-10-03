
/** Common names models invent for the 12 tools (lower-cased, separators stripped). */
const TOOL_ALIASES: Record<string, string> = {
  readfile: "read",
  viewfile: "read",
  view: "read",
  cat: "read",
  openfile: "read",
  editfile: "edit",
  strreplace: "edit",
  strreplaceeditor: "edit",
  replace: "edit",
  applyedit: "edit",
  writefile: "edit",
  write: "edit",
  createfile: "edit",
  shell: "bash",
  runcommand: "bash",
  run: "bash",
  terminal: "bash",
  exec: "bash",
  execute: "bash",
  executecommand: "bash",
  search: "grep",
  ripgrep: "grep",
  rg: "grep",
  searchfiles: "grep",
  findfiles: "glob",
  listfiles: "glob",
  todowrite: "todo",
  todos: "todo",
  updatetodos: "todo",
  websearch: "web",
  webfetch: "web",
  fetch: "web",
}

const squash = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "")

/**
 * Resolve a tool name the registry doesn't know: case/separator-insensitive
 * match first (`Bash`, `READ`), then the alias table (`read_file`,
 * `str_replace`). Returns undefined when nothing matches unambiguously.
 */
export function resolveToolName(name: string, known: Iterable<string>): string | undefined {
  const names = [...known]
  const key = squash(name)
  const direct = names.filter((candidate) => squash(candidate) === key)
  if (direct.length === 1) return direct[0]
  const alias = TOOL_ALIASES[key]
  return alias !== undefined && names.includes(alias) ? alias : undefined
}

/**
 * Close what a truncated JSON object left open: an unterminated string, then
 * brackets/braces in reverse order. A trailing comma or a dangling key is
 * dropped first. Returns undefined when the text doesn't look like a
 * truncated object at all.
 */
export function closeTruncatedJson(text: string): string | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith("{")) return undefined
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (const char of trimmed) {
    if (inString) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === "{") stack.push("}")
    else if (char === "[") stack.push("]")
    else if (char === "}" || char === "]") {
      if (stack.pop() !== char) return undefined
    }
  }
  if (stack.length === 0 && !inString) return undefined // not truncated
  let repaired = inString ? `${trimmed}${escaped ? "\\" : ""}"` : trimmed
  repaired = repaired.replace(/,\s*$/, "").replace(/,?\s*"[^"]*"\s*:\s*$/, "")
  return repaired + stack.reverse().join("")
}

/**
 * Turn a string-typed tool input back into an object: string-encoded JSON
 * (some Qwen/Kimi templates double-encode arguments) or JSON cut off by an
 * output cap. Non-strings and unparseable strings come back unchanged.
 */
export function repairToolInput(raw: unknown): { input: unknown; note?: string } {
  if (typeof raw !== "string") return { input: raw }
  const parse = (text: string): unknown => {
    try {
      return JSON.parse(text)
    } catch {
      return undefined
    }
  }
  const isObject = (value: unknown) =>
    typeof value === "object" && value !== null && !Array.isArray(value)
  const direct = parse(raw)
  if (isObject(direct)) {
    return { input: direct, note: "arguments arrived as a JSON string; pass them as an object" }
  }
  const closed = closeTruncatedJson(raw)
  const repaired = closed === undefined ? undefined : parse(closed)
  if (isObject(repaired)) {
    return { input: repaired, note: "arguments were truncated JSON; repaired by closing it" }
  }
  return { input: raw }
}
