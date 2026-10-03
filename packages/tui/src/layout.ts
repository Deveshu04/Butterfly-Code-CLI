import type { SubagentUpdate } from "@butterfly/core"
import { humanizeTokens, middleEllipsize } from "./format"

export const SIDEBAR_MIN_WIDTH = 120
export const AGENTS_PANE_MIN_WIDTH = 180
/** A shown panel hides only this many columns below its threshold (no flapping while resizing). */
export const HYSTERESIS = 4

export type SidebarPref = "auto" | "on" | "off"

export interface LayoutPlan {
  sidebar: boolean
  sidebarWidth: number
  agentsPane: boolean
  agentsWidth: number
  /** Narrow mode: a one/two-line plan + agents strip above the composer. */
  strip: boolean
}

export function planLayout(
  width: number,
  opts: { pref: SidebarPref; hasAgents: boolean; sessionStarted: boolean; previous?: LayoutPlan },
): LayoutPlan {
  const at = (threshold: number, shown: boolean | undefined) =>
    width >= (shown ? threshold - HYSTERESIS : threshold)
  const wide = at(SIDEBAR_MIN_WIDTH, opts.previous?.sidebar)
  const sidebar =
    opts.pref === "on" ? width >= 90 : opts.pref === "off" ? false : wide && opts.sessionStarted
  const sidebarWidth = width >= 180 ? 42 : width >= 140 ? 38 : 32
  const agentsPane =
    sidebar && opts.hasAgents && at(AGENTS_PANE_MIN_WIDTH, opts.previous?.agentsPane)
  return {
    sidebar,
    sidebarWidth,
    agentsPane,
    agentsWidth: width >= 210 ? 38 : 34,
    strip: !sidebar && opts.sessionStarted,
  }
}

// --- plan (todos) -----------------------------------------------------------

export interface TodoItemView {
  text: string
  status: "pending" | "in_progress" | "completed"
}

const TODO_MARK: Record<TodoItemView["status"], string> = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]",
}

export function todoProgress(todos: TodoItemView[]): { done: number; total: number } {
  return { done: todos.filter((t) => t.status === "completed").length, total: todos.length }
}

/** One row per item, wrapped to `width` with a hanging indent under the text. */
export function todoRows(
  todos: TodoItemView[],
  width: number,
): { text: string; status: TodoItemView["status"] }[] {
  const rows: { text: string; status: TodoItemView["status"] }[] = []
  const textWidth = Math.max(8, width - 4)
  for (const todo of todos) {
    const words = todo.text.replace(/\s+/g, " ").trim().split(" ")
    let line = ""
    let first = true
    const flush = () => {
      rows.push({ text: `${first ? TODO_MARK[todo.status] : "   "} ${line}`, status: todo.status })
      first = false
      line = ""
    }
    for (const word of words) {
      const piece = word.length > textWidth ? `${word.slice(0, textWidth - 1)}~` : word
      if (line !== "" && line.length + 1 + piece.length > textWidth) flush()
      line = line === "" ? piece : `${line} ${piece}`
    }
    flush()
  }
  return rows
}

export function planWindow(
  todos: TodoItemView[],
  max: number,
): { items: TodoItemView[]; doneBefore: number; moreAfter: number } {
  if (todos.length <= max) return { items: todos, doneBefore: 0, moreAfter: 0 }
  let firstOpen = todos.findIndex((t) => t.status !== "completed")
  if (firstOpen === -1) firstOpen = todos.length - max
  const start = Math.max(0, Math.min(firstOpen, todos.length - max))
  const items = todos.slice(start, start + max)
  return { items, doneBefore: start, moreAfter: todos.length - start - items.length }
}

/** The narrow-mode strip line: progress plus the item being worked on. */
export function todoStripLine(todos: TodoItemView[], width: number): string {
  if (todos.length === 0) return ""
  const { done, total } = todoProgress(todos)
  const current =
    todos.find((t) => t.status === "in_progress") ?? todos.find((t) => t.status === "pending")
  const head = `plan ${done}/${total}`
  if (!current) return `${head}  all done`
  return middleEllipsize(
    `${head}  ${TODO_MARK[current.status]} ${current.text}`,
    Math.max(20, width),
  )
}

// --- agents -----------------------------------------------------------------

/** A subagent as the TUI tracks it: the latest update plus which call spawned it. */
export interface AgentEntry extends SubagentUpdate {
  /** Unique across the session: `${callId}:${id}`. */
  key: string
  callId: string
  updatedAt: number
}

const PHASE_WORD: Record<SubagentUpdate["phase"], string> = {
  queued: "queued",
  running: "run",
  done: "done",
  failed: "FAIL",
}

export function agentCounts(agents: AgentEntry[]): {
  running: number
  done: number
  failed: number
  total: number
} {
  return {
    running: agents.filter((a) => a.phase === "running" || a.phase === "queued").length,
    done: agents.filter((a) => a.phase === "done").length,
    failed: agents.filter((a) => a.phase === "failed").length,
    total: agents.length,
  }
}

/** Two rows per agent: "#2 run  s4  <brief>" and the dimmed current activity. */
export function agentRows(
  agent: AgentEntry,
  ordinal: number,
  width: number,
  selected = false,
): [string, string] {
  const head = `${selected ? ">" : "#"}${ordinal} ${PHASE_WORD[agent.phase].padEnd(6)}${agent.steps > 0 ? `s${agent.steps} ` : ""}`
  const brief = agent.task.replace(/\s+/g, " ").trim()
  const first = `${head}${brief}`
  const activity =
    agent.phase === "running"
      ? agent.activity
      : agent.phase === "queued"
        ? "waiting for a slot"
        : `${agent.phase === "failed" ? "failed" : "finished"} · ${agent.model}`
  return [
    first.length > width ? `${first.slice(0, Math.max(4, width - 1))}~` : first,
    middleEllipsize(`   ${activity.replace(/\s+/g, " ")}`, Math.max(10, width)),
  ]
}

export function agentStripLine(agents: AgentEntry[]): string {
  if (agents.length === 0) return ""
  const c = agentCounts(agents)
  const parts = [`agents ${c.total}`]
  if (c.running > 0) parts.push(`${c.running} running`)
  if (c.done > 0) parts.push(`${c.done} done`)
  if (c.failed > 0) parts.push(`${c.failed} failed`)
  return `${parts.join(" · ")}  (Alt+Right to view)`
}

// --- usage ------------------------------------------------------------------

/** "[#########---------] 47%" — ASCII gauge sized to `width` cells. */
export function gauge(fraction: number, width: number): string {
  const cells = Math.max(4, width - 7)
  const clamped = Math.min(1, Math.max(0, fraction))
  const filled = Math.round(clamped * cells)
  return `[${"#".repeat(filled)}${"-".repeat(cells - filled)}] ${String(Math.round(clamped * 100)).padStart(3)}%`
}

export function usageLines(u: {
  ctxUsed: number
  ctxLimit?: number
  input: number
  output: number
  cacheRead: number
  costUSD: string
  width: number
}): string[] {
  const lines: string[] = []
  if (u.ctxLimit && u.ctxLimit > 0) {
    lines.push(gauge(u.ctxUsed / u.ctxLimit, u.width))
    lines.push(`${humanizeTokens(u.ctxUsed)} of ${humanizeTokens(u.ctxLimit)} context`)
  } else {
    lines.push(`${humanizeTokens(u.ctxUsed)} context (limit unknown)`)
  }
  const cachePct = u.input > 0 ? Math.round((u.cacheRead / u.input) * 100) : 0
  lines.push(`in ${humanizeTokens(u.input)} · out ${humanizeTokens(u.output)}`)
  lines.push(`cache ${cachePct}% · spent ${u.costUSD}`)
  return lines
}

// --- compact tool results ----------------------------------------------------

export function compactToolResult(name: string, output: string): string | undefined {
  const first = output.split("\n", 1)[0] ?? ""
  switch (name) {
    case "read": {
      if (first.startsWith("[unchanged]")) return "unchanged, already in context"
      const showing = first.match(/showing lines (\d+)-(\d+) of (\d+)\]/)
      if (showing) return `lines ${showing[1]}-${showing[2]} of ${showing[3]}`
      const total = first.match(/: (\d+) lines\]/)
      return total ? `${total[1]} lines` : "read"
    }
    case "glob": {
      if (first.startsWith("No files match")) return "no matches"
      const more = output.match(/\[\.\.\. (\d+) more matches/)
      const shown = output.split("\n").filter((l) => l !== "" && !l.startsWith("[...")).length
      const total = shown + (more ? Number(more[1]) : 0)
      return `${total} file${total === 1 ? "" : "s"}`
    }
    case "grep": {
      if (first.startsWith("No matches")) return "no matches"
      const more = output.match(/\[\.\.\. (\d+) more matches/)
      const lines = output.split("\n").filter((l) => l !== "" && !l.startsWith("[...")).length
      const total = lines + (more ? Number(more[1]) : 0)
      const files = new Set(
        output
          .split("\n")
          .map((l) => l.split(":", 1)[0])
          .filter(Boolean),
      ).size
      return `${total} match${total === 1 ? "" : "es"} in ${files} file${files === 1 ? "" : "s"}`
    }
    case "todo":
      return "plan updated"
    case "explore":
    case "memory":
    case "skill":
    case "web":
    case "mcp":
      return `${output.split("\n").length} lines`
    default:
      return undefined
  }
}
