import { readdirSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import type { ReasoningEffort } from "@butterfly/core"


export interface CommandActions {
  info(text: string, structured?: boolean): void
  error(text: string): void
  openSetup(): void
  quit(): void
  newSession(): void
  compact(): Promise<void>
  status(): string
  showModels(): Promise<void>
  switchModel(idOrRef: string): void
  setReasoning(level: ReasoningEffort | undefined): void
  reasoning(): ReasoningEffort | undefined
  memoryText(): string
  permissionsText(): string
  skillsText(): string
  listSessionsText(): string
  /** Arrow-key picker over past sessions (same rows as listSessionsText). */
  pickSession(): void
  resumeSession(indexOrId: string): void
  exportTranscript(): void
  undo(): Promise<void>
  rewind(): void
  pickEffort(): void
  togglePlan(): void
  planMode(): boolean
  contextText(): string
  initProject(): void
  mcpStatus(): string
  forkNow(): void
  doctorText(): string
  hooksText(): string
  toggleHook(indexArg: string): void
  review(arg: string): Promise<void>
  commit(): Promise<void>
  pasteImage(): Promise<void>
  handoff(): Promise<void>
  tasksText(): string
  killTask(id: string): void
  showTask(id: string): string
  loopPlan(goal: string): Promise<void>
  loopRun(allowDirty: boolean): Promise<void>
  loopStatusText(): string
  /** Opens the theme picker (windowed, like /model). */
  pickTheme(): void
  /** Switches + persists (saveGlobalConfig) the named theme. */
  setTheme(name: string): void
  /** Opens the provider picker: (current)/[key] markers, like pickTheme. */
  pickProvider(): void
  /** `/provider <name>` — exact or unique-prefix match; also the picker's onPick target. */
  selectProvider(nameOrPrefix: string): void
}

export interface SlashCommand {
  name: string
  /** Argument hint shown in /help, e.g. "<model>" — empty when none. */
  args: string
  description: string
  aliases?: string[]
  keywords?: string[]
  run(arg: string, actions: CommandActions): void | Promise<void>
}

export const REASONING_LEVELS: ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]

export const COMMANDS: SlashCommand[] = [
  {
    name: "help",
    args: "",
    description: "list commands",
    keywords: ["?", "commands", "man", "docs", "usage-guide", "shortcuts"],
    run: (_arg, a) => a.info(renderHelp(), true),
  },
  {
    name: "setup",
    args: "",
    description: "configure provider, API key, and model",
    keywords: ["configure", "config", "onboard", "login", "apikey", "api-key", "key", "settings"],
    run: (_arg, a) => a.openSetup(),
  },
  {
    name: "provider",
    args: "[name]",
    description: "switch provider, API key, and model — picker-based",
    aliases: ["providers"],
    keywords: [
      "vendor",
      "backend",
      "api",
      "switch-provider",
      "sarvam",
      "openrouter",
      "anthropic",
      "openai",
      "gemini",
      "ollama",
    ],
    run: (arg, a) => {
      if (arg.trim() === "") a.pickProvider()
      else a.selectProvider(arg.trim())
    },
  },
  {
    name: "model",
    args: "[id]",
    description: "list models for the current provider, or switch",
    aliases: ["models"],
    keywords: ["llm", "switch", "switch-model", "change-model", "set-model", "engine", "brain"],
    run: async (arg, a) => {
      if (arg === "") await a.showModels()
      else a.switchModel(arg)
    },
  },
  {
    name: "think",
    args: "[level]",
    description: "thinking effort — no arg opens the picker",
    aliases: ["reasoning", "effort"],
    keywords: ["thinking", "reason", "depth", "level", "budget-thinking", "ultrathink"],
    run: (typed, a) => {
      if (typed === "") {
        a.pickEffort()
        return
      }
      // Everyday words for the ends of the dial.
      const arg =
        typed === "max" || typed === "ultra" || typed === "ultrathink"
          ? "xhigh"
          : typed === "min"
            ? "minimal"
            : typed
      if (arg === "off" || arg === "default") {
        a.setReasoning(undefined)
        a.info("thinking effort reset to provider default")
        return
      }
      if ((REASONING_LEVELS as string[]).includes(arg)) {
        a.setReasoning(arg as ReasoningEffort)
        a.info(`thinking effort set to ${arg} (this session)`)
        return
      }
      a.error(`unknown level "${arg}" — use ${REASONING_LEVELS.join("|")} or off`)
    },
  },
  {
    name: "new",
    args: "",
    description: "start a fresh session (new journal, clean context)",
    aliases: ["clear"],
    keywords: ["reset", "fresh", "restart", "start-over", "clean"],
    run: (_arg, a) => a.newSession(),
  },
  {
    name: "compact",
    args: "",
    description: "summarize older context now to free the window",
    keywords: ["summarize", "summarise", "compress", "shrink", "condense", "trim"],
    run: (_arg, a) => a.compact(),
  },
  {
    name: "status",
    args: "",
    description: "model, context usage, tokens, session paths",
    aliases: ["usage", "cost"],
    keywords: ["info", "stats", "tokens", "spend", "billing", "whoami"],
    run: (_arg, a) => a.info(a.status(), true),
  },
  {
    name: "memory",
    args: "",
    description: "show project + user memory files",
    keywords: ["remember", "notes", "mem", "facts", "recall"],
    run: (_arg, a) => a.info(a.memoryText()),
  },
  {
    name: "permissions",
    args: "",
    description: "show the effective permission rules",
    keywords: ["perms", "allow", "deny", "approvals", "rules", "trust"],
    run: (_arg, a) => a.info(a.permissionsText()),
  },
  {
    name: "skills",
    args: "",
    description: "list available skills",
    keywords: ["skill", "playbooks", "recipes"],
    run: (_arg, a) => a.info(a.skillsText()),
  },
  {
    name: "resume",
    args: "[n|id]",
    description: "pick a past session to continue — no arg opens the picker",
    aliases: ["continue"],
    keywords: [
      "history",
      "restore",
      "load",
      "reopen",
      "previous",
      "past",
      "chats",
      "conversations",
    ],
    run: (arg, a) => {
      if (arg.trim() === "") a.pickSession()
      else a.resumeSession(arg.trim())
    },
  },
  {
    name: "sessions",
    args: "[n|id]",
    description: "list past sessions as text, or resume one by number/id",
    keywords: ["list-sessions", "journals"],
    run: (arg, a) => {
      if (arg === "") a.info(a.listSessionsText(), true)
      else a.resumeSession(arg)
    },
  },
  {
    name: "export",
    args: "",
    description: "write this session's transcript to a markdown file",
    keywords: ["save", "dump", "download", "transcript", "markdown"],
    run: (_arg, a) => a.exportTranscript(),
  },
  {
    name: "fork",
    args: "",
    description: "branch this conversation — history copies, futures diverge",
    aliases: ["branch"],
    keywords: ["duplicate", "clone", "split"],
    run: (_arg, a) => a.forkNow(),
  },
  {
    name: "handoff",
    args: "",
    description: "write a goal/state/next-move/files doc for the next session (cheap goodbye)",
    keywords: ["wrap-up", "wrapup", "hand-off", "summary", "farewell"],
    run: (_arg, a) => a.handoff(),
  },
  {
    name: "undo",
    args: "",
    description: "revert files AND conversation to before the last turn",
    keywords: ["revert", "oops", "back", "unedit"],
    run: (_arg, a) => a.undo(),
  },
  {
    name: "rewind",
    args: "",
    description: "browse checkpoints (turns + tool calls), pick what to restore",
    keywords: ["checkpoint", "checkpoints", "rollback", "timeline", "restore-point", "time-travel"],
    run: (_arg, a) => a.rewind(),
  },
  {
    name: "plan",
    args: "",
    description: "toggle plan mode (read-only: no edits, no shell)",
    keywords: ["read-only", "readonly", "planning", "architect", "design"],
    run: (_arg, a) => a.togglePlan(),
  },
  {
    name: "context",
    args: "",
    description: "show what fills the context window",
    keywords: ["window", "ctx", "breakdown", "budget"],
    run: (_arg, a) => a.info(a.contextText(), true),
  },
  {
    name: "init",
    args: "",
    description: "analyze the repo and seed durable project memory",
    keywords: ["bootstrap", "analyze", "analyse", "onboard-repo", "seed"],
    run: (_arg, a) => a.initProject(),
  },
  {
    name: "mcp",
    args: "",
    description: "MCP servers: status, tool count, tokens saved",
    keywords: ["servers", "integrations", "connectors", "plugins"],
    run: (_arg, a) => a.info(a.mcpStatus()),
  },
  {
    name: "doctor",
    args: "",
    description: "context audit: prefix, journal, MCP savings, config lint",
    aliases: ["checkup"],
    keywords: ["health", "diagnose", "diagnostics", "check", "lint-config"],
    run: (_arg, a) => a.info(a.doctorText(), true),
  },
  {
    name: "hooks",
    args: "[n]",
    description: "list configured hooks + last-run stats, or /hooks <n> to enable/disable",
    keywords: ["hook", "triggers", "automation"],
    run: (arg, a) => {
      if (arg.trim() === "") a.info(a.hooksText())
      else a.toggleHook(arg.trim())
    },
  },
  {
    name: "review",
    args: "[range|--staged]",
    description: "read-only subagent review of the diff (correctness/tests/security/conventions)",
    keywords: ["code-review", "cr", "audit", "inspect", "critique"],
    run: (arg, a) => a.review(arg),
  },
  {
    name: "commit",
    args: "",
    description: "generate a commit message from the staged diff, commit on approval",
    keywords: ["git-commit", "save-changes", "checkin"],
    run: (_arg, a) => a.commit(),
  },
  {
    name: "tasks",
    args: "[kill|show <id>]",
    description: "background bash tasks (bash background:true): list, kill <id>, or show <id>",
    keywords: ["jobs", "background", "bg", "ps", "processes"],
    run: (arg, a) => {
      const trimmed = arg.trim()
      if (trimmed === "") {
        a.info(a.tasksText())
        return
      }
      const [verb, ...rest] = trimmed.split(/\s+/)
      const id = rest.join(" ")
      if (verb === "kill" && id) {
        a.killTask(id)
        return
      }
      if (verb === "show" && id) {
        a.info(a.showTask(id))
        return
      }
      a.error("usage: /tasks | /tasks kill <id> | /tasks show <id>")
    },
  },
  {
    name: "loop",
    args: "plan <goal> | run [--allow-dirty] | status",
    description:
      "autonomous multi-task loop: plan tasks, run the supervisor, or check queue status",
    keywords: ["autopilot", "autonomous", "auto", "ralph", "long-running", "batch", "agent-loop"],
    run: (arg, a) => {
      const trimmed = arg.trim()
      if (trimmed === "" || trimmed === "status") {
        a.info(a.loopStatusText())
        return
      }
      if (trimmed === "run" || trimmed.startsWith("run ")) {
        const flag = trimmed.slice(3).trim()
        if (flag !== "" && flag !== "--allow-dirty") {
          a.error(`unknown option "${flag}" — usage: /loop run [--allow-dirty]`)
          return
        }
        return a.loopRun(flag === "--allow-dirty")
      }
      if (trimmed === "plan" || trimmed.startsWith("plan ")) {
        const goal = trimmed.slice(4).trim()
        if (goal === "") {
          a.error("usage: /loop plan <goal>")
          return
        }
        return a.loopPlan(goal)
      }
      a.error("usage: /loop plan <goal> | /loop run [--allow-dirty] | /loop status")
    },
  },
  {
    name: "theme",
    args: "[name]",
    description: "color theme (dark/light/dark-ansi/light-ansi/custom) — no arg opens the picker",
    keywords: ["colors", "colours", "appearance", "dark", "light", "skin"],
    run: (arg, a) => {
      if (arg.trim() === "") a.pickTheme()
      else a.setTheme(arg.trim())
    },
  },
  {
    name: "paste-img",
    args: "",
    description: "attach an image from the clipboard (Windows shim)",
    keywords: ["image", "img", "screenshot", "picture", "attach", "paste-image"],
    run: (_arg, a) => a.pasteImage(),
  },
  {
    name: "quit",
    args: "",
    description: "exit butterfly",
    aliases: ["exit"],
    keywords: ["bye", "leave", "close", "q", "stop"],
    run: (_arg, a) => a.quit(),
  },
]


export interface CustomCommand {
  name: string
  description: string
  template: string
  path: string
}

/** First dir wins on name clashes (project overrides user). */
export function loadCustomCommands(dirs: string[]): CustomCommand[] {
  const commands: CustomCommand[] = []
  const seen = new Set<string>()
  for (const dir of dirs) {
    let entries: string[]
    try {
      entries = readdirSync(dir).filter((name) => name.endsWith(".md"))
    } catch {
      continue
    }
    for (const entry of entries) {
      const name = basename(entry, ".md").toLowerCase()
      if (seen.has(name) || COMMANDS.some((c) => c.name === name || c.aliases?.includes(name))) {
        continue
      }
      try {
        const raw = readFileSync(join(dir, entry), "utf8")
        const front = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
        const description =
          front?.[1]?.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "custom command"
        const template = (front ? (front[2] ?? "") : raw).trim()
        if (template === "") continue
        seen.add(name)
        commands.push({ name, description, template, path: join(dir, entry) })
      } catch {
        // unreadable file — skip
      }
    }
  }
  return commands.sort((a, b) => a.name.localeCompare(b.name))
}

/** $ARGUMENTS = the whole arg line; $1..$9 positional (unfilled stay literal). */
export function expandTemplate(template: string, argsLine: string): string {
  const parts = argsLine.split(/\s+/).filter((part) => part !== "")
  let out = template.replaceAll("$ARGUMENTS", argsLine)
  for (let i = 1; i <= 9; i++) {
    const value = parts[i - 1]
    if (value !== undefined) out = out.replaceAll(`$${i}`, value)
  }
  return out
}

const HELP_USAGE_COL = 26
const HELP_DESC_WIDTH = 54

function wrapHanging(text: string, indent: number, width: number): string {
  const words = text.split(/\s+/).filter((w) => w !== "")
  const pad = " ".repeat(indent)
  const lines: string[] = []
  let current = ""
  for (const word of words) {
    const next = current === "" ? word : `${current} ${word}`
    if (next.length > width && current !== "") {
      lines.push(current)
      current = word
    } else {
      current = next
    }
  }
  if (current !== "") lines.push(current)
  return lines.map((line, i) => (i === 0 ? line : `${pad}${line}`)).join("\n")
}

export function renderHelp(): string {
  const lines = COMMANDS.map((command) => {
    const usage = `/${command.name}${command.args ? ` ${command.args}` : ""}`
    if (usage.length <= HELP_USAGE_COL) {
      const wrapped = wrapHanging(command.description, 2 + HELP_USAGE_COL + 2, HELP_DESC_WIDTH)
      return `  ${usage.padEnd(HELP_USAGE_COL)}  ${wrapped}`
    }
    const wrapped = wrapHanging(command.description, 4, HELP_DESC_WIDTH)
    return `  ${usage}\n    ${wrapped}`
  })
  const keys = [
    "y/n answers approvals",
    "Ctrl+C interrupts, twice quits",
    "Esc cancels setup",
    "Ctrl+O opens the transcript pager",
    "Ctrl+R expands/collapses the last thinking block (this session's view only — reasoning is never journaled, so it does not survive /resume)",
  ]
  const keyLines = keys.map((key) => `  ${wrapHanging(key, 4, HELP_DESC_WIDTH)}`)
  return `commands:\n${lines.join("\n")}\nkeys:\n${keyLines.join("\n")}`
}

export interface CommandMatch {
  command: SlashCommand
  arg: string
}

export interface CommandScore {
  score: number
  /** The name, alias, or keyword that earned the score. */
  via: string
  kind: "name" | "alias" | "keyword"
}

const COMMAND_WORD = /^[a-z0-9?][a-z0-9?-]*$/

/** Optimal-string-alignment distance (Damerau with adjacent transpositions). */
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1
  const cols = b.length + 1
  const d: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0))
  for (let i = 0; i < rows; i++) (d[i] as number[])[0] = i
  for (let j = 0; j < cols; j++) (d[0] as number[])[j] = j
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const row = d[i] as number[]
      const prev = d[i - 1] as number[]
      let best = Math.min(
        (prev[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost,
      )
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, ((d[i - 2] as number[])[j - 2] as number) + 1)
      }
      row[j] = best
    }
  }
  return (d[a.length] as number[])[b.length] as number
}

function isSubsequence(needle: string, hay: string): boolean {
  let i = 0
  for (const ch of hay) if (ch === needle[i]) i++
  return i === needle.length
}

export function scoreCommand(command: SlashCommand, token: string): CommandScore | null {
  const candidates: { word: string; kind: CommandScore["kind"]; weight: number }[] = [
    { word: command.name, kind: "name", weight: 2 },
    ...(command.aliases ?? []).map((word) => ({ word, kind: "alias" as const, weight: 1 })),
    ...(command.keywords ?? []).map((word) => ({ word, kind: "keyword" as const, weight: 0 })),
  ]
  if (token === "") return { score: 1, via: command.name, kind: "name" }
  let best: CommandScore | null = null
  const consider = (score: number, word: string, kind: CommandScore["kind"]) => {
    if (!best || score > best.score) best = { score, via: word, kind }
  }
  const fuzzy = COMMAND_WORD.test(token)
  for (const { word, kind, weight } of candidates) {
    if (word === token) consider(1000 + weight * 10, word, kind)
    else if (word.startsWith(token)) consider(800 + weight * 10 - word.length, word, kind)
    else if (fuzzy && token.length >= 4 && word.includes(token))
      consider(600 + weight * 10 - word.length, word, kind)
    else if (fuzzy && token.length >= (kind === "keyword" ? 4 : 3)) {
      const allowed = token.length >= 6 ? 2 : 1
      const distance = Math.min(
        editDistance(token, word),
        word.length > token.length ? editDistance(token, word.slice(0, token.length)) : 99,
      )
      if (distance <= allowed) consider(500 + weight * 10 - distance * 40 - word.length, word, kind)
    }
  }
  if (!best && fuzzy && token.length >= 2 && isSubsequence(token, command.name)) {
    consider(200 - command.name.length, command.name, "name")
  }
  return best
}

function draftToken(draft: string): string {
  return draft.startsWith("/") ? (draft.slice(1).split(/\s+/)[0]?.toLowerCase() ?? "") : ""
}

/** Ranked matches for a token — best first, table order breaking ties. */
function rankCommands(token: string): { command: SlashCommand; score: CommandScore }[] {
  return COMMANDS.map((command, order) => ({ command, order, score: scoreCommand(command, token) }))
    .filter(
      (row): row is { command: SlashCommand; order: number; score: CommandScore } =>
        row.score !== null,
    )
    .sort((a, b) => b.score.score - a.score.score || a.order - b.order)
    .map(({ command, score }) => ({ command, score }))
}

/**
 * Dispatch resolution. A command resolves when the token is an exact
 * name/alias, an exact keyword no other command shares, or a prefix of
 * exactly one command's name/aliases. Anything else returns ranked
 * suggestions (fuzzy + synonym hits included) for "did you mean".
 */
export function findCommand(input: string): CommandMatch | { suggestions: SlashCommand[] } | null {
  if (!input.startsWith("/")) return null
  const [head = "", ...restParts] = input.slice(1).split(/\s+/)
  const token = head.toLowerCase()
  const arg = restParts.join(" ").trim()

  const exact = COMMANDS.find(
    (command) => command.name === token || command.aliases?.includes(token),
  )
  if (exact) return { command: exact, arg }

  const byKeyword = COMMANDS.filter((command) => command.keywords?.includes(token))
  if (byKeyword.length === 1 && byKeyword[0]) return { command: byKeyword[0], arg }

  const prefix = COMMANDS.filter(
    (command) =>
      command.name.startsWith(token) ||
      (command.aliases?.some((alias) => alias.startsWith(token)) ?? false),
  )
  if (token !== "" && prefix.length === 1 && prefix[0]) return { command: prefix[0], arg }
  if (token === "") return { suggestions: COMMANDS.slice() }
  return {
    suggestions: rankCommands(token)
      .map((row) => row.command)
      .slice(0, 6),
  }
}

export function commandMatches(draft: string): SlashCommand[] {
  if (!draft.startsWith("/")) return []
  return rankCommands(draftToken(draft)).map((row) => row.command)
}

export function commandMatchLabel(command: SlashCommand, draft: string): string {
  const score = scoreCommand(command, draftToken(draft))
  return score?.kind === "alias" && score.via !== command.name ? score.via : command.name
}

export function commandMatchReason(command: SlashCommand, draft: string): string {
  const token = draftToken(draft)
  const score = scoreCommand(command, token)
  if (!score || token === "") return ""
  if (score.kind === "alias" && score.via !== command.name) return `alias of /${command.name}`
  if (score.kind === "keyword") return `matches "${score.via}"`
  if (score.score < 600 && !score.via.startsWith(token)) return "did you mean?"
  return ""
}

/** Hint line for the input area while typing a command. */
export function commandHints(draft: string): string {
  const matches = commandMatches(draft).slice(0, 5)
  if (matches.length === 0) return ""
  return matches
    .map((command) => `/${commandMatchLabel(command, draft)} — ${command.description}`)
    .join("   ")
}
