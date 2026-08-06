import { readdirSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import type { ReasoningEffort } from "@butterfly/core"


export interface CommandActions {
  info(text: string): void
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
}

export interface SlashCommand {
  name: string
  /** Argument hint shown in /help, e.g. "<model>" — empty when none. */
  args: string
  description: string
  aliases?: string[]
  run(arg: string, actions: CommandActions): void | Promise<void>
}

export const REASONING_LEVELS: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high"]

export const COMMANDS: SlashCommand[] = [
  {
    name: "help",
    args: "",
    description: "list commands",
    run: (_arg, a) => a.info(renderHelp()),
  },
  {
    name: "setup",
    args: "",
    description: "configure provider, API key, and model",
    run: (_arg, a) => a.openSetup(),
  },
  {
    name: "model",
    args: "[id]",
    description: "list models for the current provider, or switch",
    aliases: ["models"],
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
    run: (arg, a) => {
      if (arg === "") {
        a.pickEffort()
        return
      }
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
    run: (_arg, a) => a.newSession(),
  },
  {
    name: "compact",
    args: "",
    description: "summarize older context now to free the window",
    run: (_arg, a) => a.compact(),
  },
  {
    name: "status",
    args: "",
    description: "model, context usage, tokens, session paths",
    aliases: ["usage", "cost"],
    run: (_arg, a) => a.info(a.status()),
  },
  {
    name: "memory",
    args: "",
    description: "show project + user memory files",
    run: (_arg, a) => a.info(a.memoryText()),
  },
  {
    name: "permissions",
    args: "",
    description: "show the effective permission rules",
    run: (_arg, a) => a.info(a.permissionsText()),
  },
  {
    name: "skills",
    args: "",
    description: "list available skills",
    run: (_arg, a) => a.info(a.skillsText()),
  },
  {
    name: "sessions",
    args: "[n|id]",
    description: "list past sessions, or resume one by number/id",
    aliases: ["resume", "continue"],
    run: (arg, a) => {
      if (arg === "") a.info(a.listSessionsText())
      else a.resumeSession(arg)
    },
  },
  {
    name: "export",
    args: "",
    description: "write this session's transcript to a markdown file",
    run: (_arg, a) => a.exportTranscript(),
  },
  {
    name: "fork",
    args: "",
    description: "branch this conversation — history copies, futures diverge",
    aliases: ["branch"],
    run: (_arg, a) => a.forkNow(),
  },
  {
    name: "handoff",
    args: "",
    description: "write a goal/state/next-move/files doc for the next session (cheap goodbye)",
    run: (_arg, a) => a.handoff(),
  },
  {
    name: "undo",
    args: "",
    description: "revert files AND conversation to before the last turn",
    run: (_arg, a) => a.undo(),
  },
  {
    name: "rewind",
    args: "",
    description: "browse checkpoints (turns + tool calls), pick what to restore",
    run: (_arg, a) => a.rewind(),
  },
  {
    name: "plan",
    args: "",
    description: "toggle plan mode (read-only: no edits, no shell)",
    run: (_arg, a) => a.togglePlan(),
  },
  {
    name: "context",
    args: "",
    description: "show what fills the context window",
    run: (_arg, a) => a.info(a.contextText()),
  },
  {
    name: "init",
    args: "",
    description: "analyze the repo and seed durable project memory",
    run: (_arg, a) => a.initProject(),
  },
  {
    name: "mcp",
    args: "",
    description: "MCP servers: status, tool count, tokens saved",
    run: (_arg, a) => a.info(a.mcpStatus()),
  },
  {
    name: "doctor",
    args: "",
    description: "context audit: prefix, journal, MCP savings, config lint",
    aliases: ["checkup"],
    run: (_arg, a) => a.info(a.doctorText()),
  },
  {
    name: "hooks",
    args: "[n]",
    description: "list configured hooks + last-run stats, or /hooks <n> to enable/disable",
    run: (arg, a) => {
      if (arg.trim() === "") a.info(a.hooksText())
      else a.toggleHook(arg.trim())
    },
  },
  {
    name: "review",
    args: "[range|--staged]",
    description: "read-only subagent review of the diff (correctness/tests/security/conventions)",
    run: (arg, a) => a.review(arg),
  },
  {
    name: "commit",
    args: "",
    description: "generate a commit message from the staged diff, commit on approval",
    run: (_arg, a) => a.commit(),
  },
  {
    name: "tasks",
    args: "[kill|show <id>]",
    description: "background bash tasks (bash background:true): list, kill <id>, or show <id>",
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
    name: "paste-img",
    args: "",
    description: "attach an image from the clipboard (Windows shim)",
    run: (_arg, a) => a.pasteImage(),
  },
  {
    name: "quit",
    args: "",
    description: "exit butterfly",
    aliases: ["exit"],
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

export function renderHelp(): string {
  const lines = COMMANDS.map((command) => {
    const usage = `/${command.name}${command.args ? ` ${command.args}` : ""}`
    return `  ${usage.padEnd(18)} ${command.description}`
  })
  return `commands:\n${lines.join("\n")}\nkeys: y/n answers approvals · Ctrl+C interrupts, twice quits · Esc cancels setup · Ctrl+O opens the transcript pager`
}

export interface CommandMatch {
  command: SlashCommand
  arg: string
}

export function findCommand(input: string): CommandMatch | { suggestions: SlashCommand[] } | null {
  if (!input.startsWith("/")) return null
  const [head = "", ...restParts] = input.slice(1).split(/\s+/)
  const token = head.toLowerCase()
  const arg = restParts.join(" ").trim()

  const exact = COMMANDS.find(
    (command) => command.name === token || command.aliases?.includes(token),
  )
  if (exact) return { command: exact, arg }

  const prefix = COMMANDS.filter((command) => command.name.startsWith(token))
  if (prefix.length === 1 && prefix[0]) return { command: prefix[0], arg }
  return { suggestions: prefix }
}

export function commandMatches(draft: string): SlashCommand[] {
  if (!draft.startsWith("/")) return []
  const token = draft.slice(1).split(/\s+/)[0]?.toLowerCase() ?? ""
  return COMMANDS.filter((command) => command.name.startsWith(token))
}

/** Hint line for the input area while typing a command. */
export function commandHints(draft: string): string {
  const matches = commandMatches(draft).slice(0, 5)
  if (matches.length === 0) return ""
  return matches.map((command) => `/${command.name} — ${command.description}`).join("   ")
}
