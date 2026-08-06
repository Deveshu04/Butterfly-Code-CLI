import { existsSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, isAbsolute, join } from "node:path"
import {
  AiSdkProvider,
  type AttentionAction,
  type ButterflyConfig,
  bashTool,
  buildSkeleton,
  buildSystem,
  clearProgressOsc,
  compactSession,
  createExploreTool,
  createMcpTool,
  createMemoryTool,
  createModelResolver,
  createSkillTool,
  createSnapshot,
  createTaskTool,
  createWebTool,
  decideAttention,
  describeGitFailure,
  describeReviewScope,
  doctor,
  EpisodicIndex,
  editTool,
  expandMentions,
  exportSessionMarkdown,
  fetchProviderModels,
  forkSession,
  formatUSD,
  frecencyStorePath,
  GraphDb,
  generateCommitMessage,
  globTool,
  grepTool,
  type ImageRef,
  journalReview,
  listMentionCandidates,
  listSessions,
  listUntracked,
  loadConfig,
  loadFrecency,
  loadMemory,
  locateHooksSource,
  McpHub,
  ModelsCatalog,
  mediaTypeForPath,
  memoryPaths,
  mutatingSubagentRegistry,
  now,
  type PermissionRules,
  parseModelRef,
  parseReviewArg,
  planQuickAdd,
  prepareImageAttachments,
  project,
  type ReasoningEffort,
  type ReviewEvent,
  type RunnerEvent,
  rankByFrecency,
  readTool,
  renderDoctorReport,
  renderMentionBlock,
  restoreSnapshot,
  reviewTurn,
  runHooks,
  runReview,
  runUserTurn,
  SessionJournal,
  type SessionSummary,
  safeRewindIndex,
  saveGlobalConfig,
  setHookEnabled,
  setPermissionRule,
  skillsIndex,
  stageAllTracked,
  syncRepo,
  type TaskToolOptions,
  ToolRegistry,
  todoTool,
  touchFrecency,
  withFrecencyTouch,
  writeCommitMessageFile,
} from "@butterfly/core"
import { decodePasteBytes, type InputRenderable, type ScrollBoxRenderable } from "@opentui/core"
import {
  onBlur,
  onFocus,
  useKeyboard,
  usePaste,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/solid"
import { type Accessor, createSignal, For, onCleanup, Show } from "solid-js"
import { saveClipboardImage } from "./clipboard"
import {
  type CommandActions,
  commandMatches,
  expandTemplate,
  findCommand,
  loadCustomCommands,
  type SlashCommand,
} from "./commands"
import { formatToolResult, stripThink } from "./format"
import { buildPagerDoc, type PagerDoc, searchPagerLines, stepLine } from "./pager"
import { PagerView } from "./pager-view"
import {
  addPasteChip,
  expandComposerText,
  insertedSpan,
  NEWLINE_MARKER,
  PASTE_RATE_HEURISTIC_CHARS,
  removeTrailingChip,
  shouldChip,
  toComposerDraft,
  unreferencedChips,
} from "./paste"
import { SYNTAX } from "./theme"
import { renderWordmark, wordmarkMode } from "./wordmark"

const MUTED = "#8b8b8b"
const ACCENT = "#c9a7ff"
const ERROR = "#ff8080"
const WARN = "#ffcc66"

interface Message {
  kind: "user" | "assistant" | "tool" | "info" | "error"
  text: string
  /** Unified diff for edit results — rendered with the diff element. */
  diff?: string
  path?: string
}

function filetypeOf(path: string | undefined): string | undefined {
  const ext = path?.split(".").pop()?.toLowerCase()
  if (ext === "ts" || ext === "tsx" || ext === "mts" || ext === "cts") return "typescript"
  if (ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs") return "javascript"
  if (ext === "md") return "markdown"
  return undefined
}

function reviewMessage(event: ReviewEvent): Message {
  const size =
    event.diffChars && event.diffChars > 0
      ? ` (${event.diffChars.toLocaleString()} diff chars${event.truncated ? ", truncated" : ""})`
      : ""
  return {
    kind: "tool",
    text: `review — ${event.scope ?? "the current diff"}${size}:\n${event.summary}`,
  }
}

export function timelineToMessages(timeline: import("@butterfly/core").SessionEvent[]): Message[] {
  const restored: Message[] = []
  for (const event of timeline) {
    if (event.type === "message.user") restored.push({ kind: "user", text: event.text })
    else if (event.type === "message.assistant" && stripThink(event.text).trim() !== "")
      restored.push({ kind: "assistant", text: event.text })
    else if (event.type === "tool.call")
      restored.push({
        kind: "tool",
        text: `→ ${event.name} ${JSON.stringify(event.input).slice(0, 120)}`,
      })
    else if (event.type === "tool.result")
      restored.push({
        kind: event.isError ? "error" : "tool",
        text: `  ${formatToolResult(event.output, event.isError)}`,
        ...(metaDiff(event.meta) ?? {}),
      })
    else if (event.type === "session.compacted")
      restored.push({ kind: "info", text: "(older context was compacted)" })
    else if (event.type === "session.review") restored.push(reviewMessage(event))
  }
  return restored
}

type SnapshotEvent = Extract<import("@butterfly/core").SessionEvent, { type: "turn.snapshot" }>

type HookRunEvent = Extract<import("@butterfly/core").SessionEvent, { type: "hook.run" }>

/** Picker row label for a checkpoint: tool + first line of args, or turn start. */
function checkpointLabel(event: SnapshotEvent): string {
  const time = event.time.slice(11, 19)
  if (event.callId) {
    const args = event.argsPreview ? `  ${event.argsPreview}` : ""
    return `${time}  ${event.tool ?? "call"}${args}`
  }
  return `${time}  (turn start)`
}

function metaDiff(meta: unknown): { diff: string; path?: string } | undefined {
  if (meta && typeof meta === "object" && "diff" in meta) {
    const m = meta as { diff: unknown; path?: unknown }
    if (typeof m.diff === "string") {
      return { diff: m.diff, ...(typeof m.path === "string" ? { path: m.path } : {}) }
    }
  }
  return undefined
}

function isMentionTrigger(previous: string, value: string): boolean {
  if (value.length !== previous.length + 1 || !value.endsWith("@")) return false
  const before = previous.at(-1)
  return before === undefined || /\s/.test(before)
}

function mentionToken(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path
}

function detectAttachableImage(
  cwd: string,
  value: string,
): { path: string; mediaType: string; remaining: string } | null {
  const match = value.match(/(\S+)$/)
  if (!match || match.index === undefined) return null
  const token = match[0]
  const mediaType = mediaTypeForPath(token)
  if (!mediaType) return null
  const abs = isAbsolute(token) ? token : join(cwd, token)
  if (!existsSync(abs)) return null
  const remaining =
    `${value.slice(0, match.index)}${value.slice(match.index + token.length)}`.replace(/\s+$/, "")
  return { path: abs, mediaType, remaining }
}

export function clearTerminalProgress(
  stream: Pick<NodeJS.WriteStream, "isTTY" | "write"> = process.stdout,
): void {
  if (!stream.isTTY) return
  try {
    stream.write(clearProgressOsc())
  } catch {
    // a dying stream must never become the last thing the user sees
  }
}

interface QuickAddOffer {
  tool: string
  pattern: string
  rules: PermissionRules
}

interface PendingAsk {
  text: string
  quickAdd?: QuickAddOffer
  resolve: (decision: "allow" | "deny") => void
}

type SetupStage =
  | { stage: "provider" }
  | { stage: "key"; provider: string }
  | { stage: "model"; provider: string; key?: string }

interface ProviderChoice {
  id: string
  needsKey: boolean
  example: string
}

const PROVIDERS: ProviderChoice[] = [
  { id: "openai", needsKey: true, example: "gpt-5-mini" },
  { id: "openrouter", needsKey: true, example: "qwen/qwen3-coder" },
  { id: "anthropic", needsKey: true, example: "claude-sonnet-4-6" },
  { id: "google", needsKey: true, example: "gemini-2.5-flash" },
  { id: "nvidia", needsKey: true, example: "meta/llama-3.3-70b-instruct" },
  { id: "ollama", needsKey: false, example: "qwen3:8b" },
  { id: "lmstudio", needsKey: false, example: "qwen/qwen3-8b" },
]

function describeAsk(request: { tool: string; target?: string; note?: string }): string {
  const target = request.target ? `: ${request.target}` : ""
  const note = request.note ? ` (${request.note})` : ""
  return `${request.tool}${target}${note}`
}

/** Interactive defaults: reads free, everything mutating (or costly/networked) asks. */
const TUI_DEFAULT_RULES: PermissionRules = {
  "*": "allow",
  bash: "ask",
  edit: { "*": "ask", "**/.env*": "deny", ".env*": "deny" },
  web: "ask",
}

const PLAN_RULES: PermissionRules = {
  "*": "allow",
  bash: "deny",
  edit: "deny",
  memory: "deny",
  web: "allow",
}

const PLAN_PREFIX =
  "[PLAN MODE — read-only. Investigate with read/glob/grep/explore, then produce a concrete numbered implementation plan (files to change, exact steps, risks, verification). Do NOT modify anything; edit/bash are disabled.]"

export function App(props: { cwd: string; config: ButterflyConfig; home?: string }) {
  const home = props.home ?? homedir()
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()

  const [focused, setFocused] = createSignal(true)
  onFocus(() => setFocused(true))
  onBlur(() => setFocused(false))

  const writeOsc = (osc: string): void => {
    ;(renderer as unknown as { writeOut: (chunk: string) => boolean }).writeOut(osc)
  }
  const applyAttention = (actions: AttentionAction[]) => {
    for (const action of actions) {
      try {
        if (action.type === "notify") renderer.triggerNotification(action.message, action.title)
        else if (action.type === "title") renderer.setTerminalTitle(action.text)
        else writeOsc(action.osc)
      } catch {
      }
    }
  }

  const [config, setConfig] = createSignal(props.config)
  const [messages, setMessages] = createSignal<Message[]>([])
  const [draft, setDraft] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [pendingAsk, setPendingAsk] = createSignal<PendingAsk | null>(null)
  const [status, setStatus] = createSignal("")
  const [ctxUsed, setCtxUsed] = createSignal(0)
  const [ctxLimit, setCtxLimit] = createSignal<number | undefined>(undefined)
  const [reasoning, setReasoning] = createSignal<ReasoningEffort | undefined>(
    props.config.reasoning,
  )
  const [setup, setSetup] = createSignal<SetupStage | null>(
    props.config.model ? null : { stage: "provider" },
  )
  const [setupModels, setSetupModels] = createSignal<string>("")
  const [picker, setPicker] = createSignal<{
    title: string
    items: { label: string; value: string }[]
    index: number
    filter: string
    onPick: (value: string) => void
  } | null>(null)
  const [cmdIndex, setCmdIndex] = createSignal(0)
  const [planMode, setPlanMode] = createSignal(false)
  const [queued, setQueued] = createSignal<string[]>([])
  const [history, setHistory] = createSignal<string[]>([])
  let historyPos = -1
  const [attachedImages, setAttachedImages] = createSignal<{ path: string; mediaType: string }[]>(
    [],
  )
  const [pasteChips, setPasteChips] = createSignal<ReadonlyMap<number, string>>(new Map())
  let nextChipNumber = 1
  let composerRef: InputRenderable | undefined

  const [pagerOpen, setPagerOpen] = createSignal(false)
  const [pagerDoc, setPagerDoc] = createSignal<PagerDoc>({ source: "", lines: [], promptLines: [] })
  const [pagerQuery, setPagerQuery] = createSignal("")
  const [pagerSearchActive, setPagerSearchActive] = createSignal(false)
  const [pagerMatches, setPagerMatches] = createSignal<number[]>([])
  const [pagerLine, setPagerLine] = createSignal(0)
  const [pagerNotice, setPagerNotice] = createSignal("")
  let pagerScroll: ScrollBoxRenderable | undefined

  const pickerItems = () => {
    const p = picker()
    if (!p) return []
    if (p.filter === "") return p.items
    const needle = p.filter.toLowerCase()
    return p.items.filter((item) => item.label.toLowerCase().includes(needle))
  }
  let scroll: ScrollBoxRenderable | undefined
  let abort: AbortController | undefined
  let firstTurn = true

  const cmdList = (): SlashCommand[] =>
    !setup() && !picker() && !busy() ? commandMatches(draft()) : []

  const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  const [spin, setSpin] = createSignal(0)
  const spinTimer = setInterval(() => {
    if (busy()) setSpin((s) => (s + 1) % SPINNER.length)
  }, 80)
  onCleanup(() => clearInterval(spinTimer))

  const modelRef = () => config().model

  const frecencyStore = frecencyStorePath(props.cwd)

  const registry = new ToolRegistry()
  registry.register(bashTool)
  registry.register(withFrecencyTouch(readTool, frecencyStore, (input) => input.file_path))
  registry.register(withFrecencyTouch(editTool, frecencyStore, (input) => input.file_path))
  registry.register(globTool)
  registry.register(grepTool)
  registry.register(todoTool)

  const [sessionCost, setSessionCost] = createSignal(0)
  const modelCost = () => {
    const ref = modelRef()
    if (!ref) return undefined
    try {
      const parsed = parseModelRef(ref)
      return catalog.lookup(parsed.providerId, parsed.modelId)?.cost
    } catch {
      return undefined
    }
  }
  const imageInputSupported = () => {
    const ref = modelRef()
    if (!ref) return false
    try {
      const parsed = parseModelRef(ref)
      return catalog.lookup(parsed.providerId, parsed.modelId)?.imageInput === true
    } catch {
      return false
    }
  }

  const session = { journal: SessionJournal.create(join(props.cwd, ".butterfly", "sessions")) }
  const state: Record<string, unknown> = {}
  let lastListing: SessionSummary[] = []
  const customCommands = loadCustomCommands([
    join(props.cwd, ".butterfly", "commands"),
    join(home, ".config", "butterfly", "commands"),
  ])

  // models.dev catalog (cached on disk): model lists + context limits.
  let catalog = ModelsCatalog.empty()
  const refreshCtxLimit = () => {
    const ref = modelRef()
    if (!ref) return
    try {
      const parsed = parseModelRef(ref)
      setCtxLimit(catalog.lookup(parsed.providerId, parsed.modelId)?.context)
    } catch {
      setCtxLimit(undefined)
    }
  }
  void ModelsCatalog.load({
    cachePath: join(home, ".config", "butterfly", "models-cache.json"),
  })
    .then((loaded) => {
      catalog = loaded
      refreshCtxLimit()
    })
    .catch(() => {})

  let graph: GraphDb | undefined
  registry.register(createExploreTool({ db: () => graph, cwd: props.cwd }))
  void (async () => {
    try {
      const db = GraphDb.open(join(props.cwd, ".butterfly", "graph.db"))
      await syncRepo(props.cwd, db)
      graph = db
    } catch {
      // explore stays unavailable; grep/read still work
    }
  })()

  const paths = memoryPaths(props.cwd, home)
  const memory = loadMemory(paths)
  const skillDirs = [
    join(props.cwd, ".butterfly", "skills"),
    join(home, ".config", "butterfly", "skills"),
  ]
  const episodic = EpisodicIndex.open(join(props.cwd, ".butterfly", "index.db"))
  registry.register(createMemoryTool({ paths, episodic: () => episodic }))
  registry.register(createSkillTool({ dirs: skillDirs }))
  registry.register(createWebTool({ config: () => config().web }))
  /** Caller-owned tools every subagent gets, read-only or mutating alike. */
  const subagentExtras = (sub: ToolRegistry) => {
    sub.register(createExploreTool({ db: () => graph, cwd: props.cwd }))
    sub.register(createWebTool({ config: () => config().web }))
  }
  const taskToolOpts: TaskToolOptions = {
    provider: () => freshProvider(),
    model: () => modelRef() ?? "",
    system: (m) => frozenSystem(m),
    cwd: props.cwd,
    sessionsDir: join(props.cwd, ".butterfly", "sessions"),
    makeRegistry: () => {
      const sub = new ToolRegistry()
      sub.register(readTool)
      sub.register(globTool)
      sub.register(grepTool)
      subagentExtras(sub)
      return sub
    },
    makeMutatingRegistry: () => mutatingSubagentRegistry(subagentExtras),
  }
  registry.register(createTaskTool(taskToolOpts))
  if (props.config.hooks?.length) {
    void runHooks(
      props.config.hooks,
      "session.start",
      { cwd: props.cwd },
      { onRun: (run) => session.journal.append({ type: "hook.run", ...run, time: now() }) },
    ).catch(() => {})
  }

  // MCP: connect in the background; the mcp tool works once the hub is up.
  let mcpHub: McpHub | undefined
  registry.register(createMcpTool({ hub: () => mcpHub }))
  if (props.config.mcp && Object.keys(props.config.mcp).length > 0) {
    void McpHub.connect(props.config.mcp)
      .then((hub) => {
        mcpHub = hub
        const saved = hub.eagerTokens() - hub.indexTokens()
        push({
          kind: "info",
          text: `mcp: ${hub.status().length} server(s) connected — lazy disclosure saves ~${saved.toLocaleString()} tokens/turn vs eager injection (/mcp for details)`,
        })
      })
      .catch(() => {})
  }
  const frozenSystem = (ref: string) =>
    buildSystem(ref, {
      cwd: props.cwd,
      platform: process.platform,
      date: new Date().toISOString().slice(0, 10),
      projectMemory: memory.project,
      userMemory: memory.user,
      skillsIndex: skillsIndex(skillDirs),
    })

  const quit = () => {
    try {
      renderer.destroy()
    } catch {
      clearTerminalProgress()
      process.exit(0)
    }
  }

  const push = (message: Message) => {
    setMessages([...messages(), message])
    scroll?.scrollTo(scroll.scrollHeight)
  }

  const showApprovalPrompt = (text: string, quickAdd?: QuickAddOffer): Promise<"allow" | "deny"> =>
    new Promise((resolve) => {
      // Terminal bell: surfaces the prompt when the user has tabbed away.
      process.stdout.write("\x07")
      applyAttention(
        decideAttention(
          { kind: "approval.request", detail: text },
          { focus: focused() ? "focused" : "blurred", cwd: props.cwd },
          { notifications: config().notifications ?? true },
        ),
      )
      setPendingAsk({
        text,
        quickAdd,
        resolve: (decision) => {
          setPendingAsk(null)
          resolve(decision)
        },
      })
    })

  const askApproval = (text: string): Promise<"allow" | "deny"> => showApprovalPrompt(text)

  const askPermission = (
    request: { tool: string; target?: string; note?: string; input: unknown },
    rules: PermissionRules,
  ): Promise<"allow" | "deny"> => {
    const plan = planQuickAdd(rules, request.tool, request.target)
    const quickAdd: QuickAddOffer | undefined =
      plan.ok && plan.rules
        ? { tool: plan.tool, pattern: plan.pattern, rules: plan.rules }
        : undefined
    return showApprovalPrompt(describeAsk(request), quickAdd)
  }

  const applyQuickAdd = (quickAdd: QuickAddOffer) => {
    setConfig({ ...config(), permissions: quickAdd.rules })
    try {
      const result = setPermissionRule(quickAdd.tool, quickAdd.pattern, { cwd: props.cwd, home })
      push({
        kind: "info",
        text: result.ok
          ? `always allow ${quickAdd.tool}: "${quickAdd.pattern}" — saved to ${result.path}`
          : `always allow ${quickAdd.tool}: "${quickAdd.pattern}" for this session — ${result.path} has comments, edit it by hand:\n  ${result.snippet}`,
      })
    } catch (error) {
      push({
        kind: "info",
        text: `always allow ${quickAdd.tool}: "${quickAdd.pattern}" for this session — could not save to butterfly.jsonc: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  const appendAssistant = (text: string) => {
    const all = [...messages()]
    const last = all.at(-1)
    if (last?.kind === "assistant") {
      all[all.length - 1] = { kind: "assistant", text: last.text + text }
    } else {
      all.push({ kind: "assistant", text })
    }
    setMessages(all)
    scroll?.scrollTo(scroll.scrollHeight)
  }

  const openMentionPicker = () => {
    const candidates = listMentionCandidates(props.cwd, graph)
    const ranked = rankByFrecency(candidates, loadFrecency(frecencyStore))
    setPicker({
      title: "@ mention a file",
      items: ranked.map((path) => ({ label: path, value: path })),
      index: 0,
      filter: "",
      onPick: (value) => {
        touchFrecency(frecencyStore, value)
        setDraft(`${draft()}${mentionToken(value)} `)
      },
    })
  }

  const openPager = () => {
    const source = exportSessionMarkdown(session.journal.path)
    setPagerDoc(buildPagerDoc(source))
    setPagerQuery("")
    setPagerSearchActive(false)
    setPagerMatches([])
    setPagerLine(0)
    setPagerNotice("")
    setPagerOpen(true)
  }
  const closePager = () => setPagerOpen(false)

  const runPagerSearch = (query: string) => {
    setPagerQuery(query)
    const matches = searchPagerLines(pagerDoc().lines, query)
    setPagerMatches(matches)
    if (matches.length > 0) {
      const line = stepLine(matches, pagerLine() - 1, 1)
      setPagerLine(line)
      pagerScroll?.scrollTo(line)
    }
  }

  const writePagerExport = (): string => {
    const id = session.journal.header.sessionId.slice(0, 8)
    const file = join(tmpdir(), `butterfly-pager-${id}-${Date.now()}.md`)
    writeFileSync(file, pagerDoc().source)
    return file
  }

  const pagerDumpScrollback = () => {
    const file = writePagerExport()
    let suspended = false
    try {
      renderer.suspend()
      suspended = true
      process.stdout.write(`${pagerDoc().source}\n`)
      setPagerNotice(`dumped to scrollback — also saved ${basename(file)} (temp dir)`)
    } catch {
      setPagerNotice(
        `scrollback dump unavailable on this terminal — saved ${basename(file)} (temp dir)`,
      )
    } finally {
      if (suspended) {
        try {
          renderer.resume()
        } catch {
        }
      }
    }
  }

  const pagerExportAndEdit = async (): Promise<void> => {
    const file = writePagerExport()
    const editor = process.env.VISUAL || process.env.EDITOR
    if (!editor) {
      setPagerNotice(`no $EDITOR/$VISUAL set — exported to ${basename(file)} (temp dir)`)
      return
    }
    try {
      renderer.suspend()
    } catch {
      setPagerNotice(
        `exported to ${basename(file)} (temp dir) — open manually, suspend unavailable`,
      )
      return
    }
    try {
      const parts = editor.trim().split(/\s+/)
      const proc = Bun.spawn([...parts, file], { stdio: ["inherit", "inherit", "inherit"] })
      await proc.exited
      setPagerNotice(`edited ${basename(file)}`)
    } catch (error) {
      setPagerNotice(
        `could not launch ${editor}: ${String(error)} — saved ${basename(file)} (temp dir)`,
      )
    } finally {
      try {
        renderer.resume()
      } catch {
      }
    }
  }

  const onEvent = (event: RunnerEvent) => {
    switch (event.type) {
      case "text-delta":
        appendAssistant(event.text)
        break
      case "tool-call":
        push({ kind: "tool", text: `→ ${event.name} ${JSON.stringify(event.input).slice(0, 120)}` })
        break
      case "tool-result": {
        const diffMeta = metaDiff(event.meta)
        push({
          kind: event.isError ? "error" : "tool",
          text: `  ${formatToolResult(event.output, event.isError)}`,
          ...(diffMeta ?? {}),
        })
        break
      }
      case "finish":
        // Live context gauge: the last step's input+output IS the window size.
        setCtxUsed(event.usage.input + event.usage.output)
        break
      case "notice":
        push({ kind: "info", text: event.text })
        break
      default:
        break
    }
  }

  const freshProvider = () => new AiSdkProvider(createModelResolver(config()))

  const modelListItems = async (
    providerId: string,
    apiKey?: string,
  ): Promise<{ id: string; context?: number; name?: string }[]> => {
    const providerConfig = config().providers?.[providerId]
    const live = await fetchProviderModels(providerId, {
      apiKey: apiKey ?? providerConfig?.apiKey,
      baseURL: providerConfig?.baseURL,
    })
    if (live.length > 0) return live
    return catalog.listModels(providerId)
  }

  const modelLabel = (m: { id: string; context?: number; name?: string }): string =>
    `${m.id}${m.context ? `  (${Math.round(m.context / 1000)}k ctx)` : ""}${m.name && m.name !== m.id ? `  — ${m.name}` : ""}`

  const modelListText = async (providerId: string, apiKey?: string): Promise<string> => {
    const models = await modelListItems(providerId, apiKey)
    if (models.length === 0) {
      return providerId === "ollama"
        ? "no local ollama models found (is the server running? `ollama pull <model>` to add one)"
        : `no model list available for "${providerId}" (offline or bad key?) — you can still type any model id`
    }
    const shown = models.slice(0, 25)
    const more = models.length - shown.length
    return `${providerId} models:\n${shown.map((m) => `  ${modelLabel(m)}`).join("\n")}${more > 0 ? `\n  … ${more} more — type any id` : ""}`
  }

  const performRewind = async (
    checkpoint: { index: number; event: SnapshotEvent },
    mode: "files" | "conversation" | "both",
  ): Promise<void> => {
    if (mode === "files" || mode === "both") {
      const restored = await restoreSnapshot(props.cwd, checkpoint.event.tree, {
        untracked: checkpoint.event.untracked,
      })
      if (!restored) {
        push({ kind: "error", text: "rewind failed — could not restore the snapshot tree" })
        return
      }
    }
    if (mode === "conversation" || mode === "both") {
      const { events: before } = SessionJournal.replay(session.journal.path)
      const toIndex = safeRewindIndex(before, checkpoint.index)
      session.journal.append({ type: "session.rewound", toIndex, time: now() })
      const { header, events } = SessionJournal.replay(session.journal.path)
      setMessages(timelineToMessages(project(header, events).timeline))
      setStatus("")
    }
    push({ kind: "info", text: `rewound (${mode}) to ${checkpointLabel(checkpoint.event)}` })
  }

  const actions: CommandActions = {
    info: (text) => push({ kind: "info", text }),
    error: (text) => push({ kind: "error", text }),
    openSetup: () => setSetup({ stage: "provider" }),
    quit,
    newSession: () => {
      session.journal = SessionJournal.create(join(props.cwd, ".butterfly", "sessions"))
      setMessages([])
      setStatus("")
      setCtxUsed(0)
      firstTurn = true
      push({ kind: "info", text: "fresh session started" })
    },
    compact: async () => {
      const ref = modelRef()
      if (!ref) {
        push({ kind: "error", text: "no model configured" })
        return
      }
      push({ kind: "info", text: "compacting…" })
      try {
        const result = await compactSession({
          provider: freshProvider(),
          model: config().small_model ?? ref,
          journal: session.journal,
        })
        push({
          kind: "info",
          text: result
            ? `compacted — summary now covers the older context:\n${result.summary.slice(0, 400)}`
            : "nothing to compact yet",
        })
      } catch (error) {
        push({ kind: "error", text: `compaction failed: ${String(error)}` })
      }
    },
    status: () => {
      const limit = ctxLimit()
      const used = ctxUsed()
      const pct = limit ? Math.round((used / limit) * 100) : undefined
      return [
        `model      ${modelRef() ?? "not configured"}`,
        `context    ${used.toLocaleString()} used${limit ? ` / ${limit.toLocaleString()} (${pct}%)` : " (limit unknown)"}`,
        `thinking   ${reasoning() ?? "provider default"}`,
        `spend      ${formatUSD(sessionCost())} this session${config().maxSpendUSD !== undefined ? ` (cap $${config().maxSpendUSD?.toFixed(2)}/turn)` : ""}`,
        `small      ${config().small_model ?? "not set"}`,
        `journal    ${session.journal.path}`,
        `last turn  ${status() || "—"}`,
      ].join("\n")
    },
    showModels: async () => {
      const ref = modelRef()
      const providerId = ref ? parseModelRef(ref).providerId : "openrouter"
      const models = await modelListItems(providerId)
      if (models.length === 0) {
        push({ kind: "info", text: await modelListText(providerId) })
        return
      }
      const currentId = ref ? parseModelRef(ref).modelId : undefined
      const index = Math.max(
        0,
        models.findIndex((m) => m.id === currentId),
      )
      setPicker({
        title: `${providerId} models — type to filter · ↑↓ · Enter switch · Esc`,
        items: models.map((m) => ({ label: modelLabel(m), value: m.id })),
        index,
        filter: "",
        onPick: (value) => actions.switchModel(value),
      })
    },
    switchModel: (idOrRef) => {
      const ref = modelRef()
      const full = idOrRef.includes("/")
        ? idOrRef
        : `${ref ? parseModelRef(ref).providerId : "openrouter"}/${idOrRef}`
      try {
        parseModelRef(full)
        saveGlobalConfig({ model: full }, { home })
        setConfig(loadConfig({ cwd: props.cwd, home }))
        refreshCtxLimit()
        setCtxUsed(0)
        push({ kind: "info", text: `model switched to ${full}` })
      } catch (error) {
        push({ kind: "error", text: String(error instanceof Error ? error.message : error) })
      }
    },
    setReasoning,
    reasoning,
    memoryText: () => {
      const current = loadMemory(paths)
      return [
        `PROJECT (${paths.project}):`,
        current.project.trim() || "  (empty)",
        "",
        `USER (${paths.user}):`,
        current.user.trim() || "  (empty)",
        "",
        "(frozen at session start — edits apply next session; the agent updates these via its memory tool)",
      ].join("\n")
    },
    permissionsText: () => JSON.stringify(config().permissions ?? TUI_DEFAULT_RULES, null, 2),
    skillsText: () =>
      skillsIndex(skillDirs) || "no skills yet — add .butterfly/skills/<name>/SKILL.md",
    listSessionsText: () => {
      lastListing = listSessions(join(props.cwd, ".butterfly", "sessions"))
      if (lastListing.length === 0) return "no sessions yet"
      const lines = lastListing.map(
        (s, i) =>
          `  ${i + 1}  ${new Date(s.modified).toISOString().slice(0, 16).replace("T", " ")}  ${s.title}${s.path === session.journal.path ? "  (current)" : ""}`,
      )
      return `sessions (newest first):\n${lines.join("\n")}\nresume with /resume <number>`
    },
    resumeSession: (indexOrId) => {
      if (lastListing.length === 0) {
        lastListing = listSessions(join(props.cwd, ".butterfly", "sessions"))
      }
      const byIndex = /^\d+$/.test(indexOrId) ? lastListing[Number(indexOrId) - 1] : undefined
      const target = byIndex ?? lastListing.find((s) => s.id.startsWith(indexOrId))
      if (!target) {
        push({ kind: "error", text: `no session "${indexOrId}" — run /sessions first` })
        return
      }
      try {
        const journal = SessionJournal.open(target.path)
        const { header, events } = SessionJournal.replay(target.path)
        session.journal = journal
        setMessages(timelineToMessages(project(header, events).timeline))
        setStatus("")
        setCtxUsed(0)
        firstTurn = false
        push({ kind: "info", text: `resumed session ${target.id.slice(0, 8)} — ${target.title}` })
      } catch (error) {
        push({ kind: "error", text: `resume failed: ${String(error)}` })
      }
    },
    pickEffort: () => {
      const levels = ["provider default", "none", "minimal", "low", "medium", "high"]
      const current = reasoning() ?? "provider default"
      setPicker({
        title: "thinking effort — ↑↓ · Enter set · Esc",
        items: levels.map((level) => ({
          label: level === current ? `${level}  (current)` : level,
          value: level,
        })),
        index: Math.max(0, levels.indexOf(current)),
        filter: "",
        onPick: (value) => {
          setReasoning(value === "provider default" ? undefined : (value as ReasoningEffort))
          push({ kind: "info", text: `thinking effort: ${value} (this session)` })
        },
      })
    },
    togglePlan: () => {
      const next = !planMode()
      setPlanMode(next)
      push({
        kind: "info",
        text: next
          ? "plan mode ON — read-only: the agent investigates and proposes; edit/bash are denied. /plan again to exit."
          : "plan mode OFF — full tool access restored.",
      })
    },
    planMode,
    contextText: () => {
      const ref = modelRef()
      const system = ref ? frozenSystem(ref) : ""
      const systemTokens = Math.ceil(system.length / 4)
      const memTokens = Math.ceil((memory.project.length + memory.user.length) / 4)
      const skillTokens = Math.ceil(skillsIndex(skillDirs).length / 4)
      let transcriptTokens = 0
      try {
        transcriptTokens = Math.ceil(require("node:fs").statSync(session.journal.path).size / 4)
      } catch {
        // fresh session
      }
      const limit = ctxLimit()
      const used = ctxUsed()
      const bar = (tokens: number): string => {
        if (!limit) return ""
        const width = Math.round((tokens / limit) * 30)
        return `  ${"█".repeat(Math.min(30, Math.max(tokens > 0 ? 1 : 0, width)))}`
      }
      return [
        `context breakdown${ref ? ` (${ref})` : ""}:`,
        `  system prompt   ~${systemTokens.toLocaleString()} tok${bar(systemTokens)}`,
        `    · memory      ~${memTokens.toLocaleString()} tok (frozen)`,
        `    · skills idx  ~${skillTokens.toLocaleString()} tok`,
        `  transcript      ~${transcriptTokens.toLocaleString()} tok (journal estimate)`,
        `  last step used  ${used.toLocaleString()} tok${bar(used)}`,
        limit
          ? `  window          ${limit.toLocaleString()} tok — ${Math.max(0, limit - used).toLocaleString()} remaining (${Math.min(100, Math.round((used / limit) * 100))}% used)`
          : "  window          unknown (model not in catalog)",
        "  hygiene: prune >40k-token-old tool outputs · auto-compact near the ceiling · /compact to force",
      ].join("\n")
    },
    forkNow: () => {
      try {
        const path = forkSession(session.journal.path, join(props.cwd, ".butterfly", "sessions"))
        session.journal = SessionJournal.open(path)
        push({
          kind: "info",
          text: `forked — this timeline is now ${session.journal.header.sessionId.slice(0, 8)}; the original stays in /sessions`,
        })
      } catch (error) {
        push({ kind: "error", text: `fork failed: ${String(error)}` })
      }
    },
    mcpStatus: () => {
      if (!props.config.mcp || Object.keys(props.config.mcp).length === 0) {
        return 'no MCP servers configured — add e.g. "mcp": {"docs": {"command": "npx", "args": ["-y", "@upstash/context7-mcp"]}} to butterfly.jsonc'
      }
      if (!mcpHub) return "mcp: still connecting…"
      const rows = mcpHub
        .status()
        .map((s) => `  ${s.name}  ${s.error ? `ERROR: ${s.error}` : `${s.toolCount} tool(s)`}`)
      const saved = mcpHub.eagerTokens() - mcpHub.indexTokens()
      return [
        "mcp servers:",
        ...rows,
        `lazy disclosure: index ${mcpHub.indexTokens()} tok vs eager ${mcpHub.eagerTokens()} tok — saving ~${saved.toLocaleString()} tok/turn`,
        "the agent uses the mcp tool: op=list → describe → call",
      ].join("\n")
    },
    doctorText: () => {
      const ref = modelRef()
      const report = doctor({
        cwd: props.cwd,
        home,
        system: ref ? frozenSystem(ref) : "",
        memoryText: memory.project + memory.user,
        skillsIndexText: skillsIndex(skillDirs),
        graphSkeletonText: graph ? buildSkeleton(graph) : "",
        journalPath: session.journal.path,
        catalog,
        ...(mcpHub ? { mcpHub } : {}),
      })
      // Proportional bars vs the context window — same formula /context uses.
      const limit = ctxLimit()
      const bar = (tokens: number): string => {
        if (!limit) return ""
        const width = Math.round((tokens / limit) * 30)
        return `  ${"█".repeat(Math.min(30, Math.max(tokens > 0 ? 1 : 0, width)))}`
      }
      return renderDoctorReport(report, { bar })
    },
    hooksText: () => {
      const hooks = config().hooks ?? []
      if (hooks.length === 0) {
        return 'no hooks configured — add a "hooks": [...] array to butterfly.jsonc'
      }
      const source = locateHooksSource({ cwd: props.cwd, home })
      const { events } = SessionJournal.replay(session.journal.path)
      const runs = events.filter((e): e is HookRunEvent => e.type === "hook.run")
      const lines = hooks.map((hook, i) => {
        const last = [...runs]
          .reverse()
          .find((r) => r.event === hook.event && r.command === hook.command)
        const state = hook.enabled === false ? "off" : "on "
        const lastText = last
          ? `last: ${last.blocked ? "BLOCKED" : last.exitCode === 0 ? "ok" : "failed"} (exit ${last.exitCode}, ${last.durationMs}ms)${last.feedback ? " — fed back to model" : ""}`
          : "last: not run this session"
        return `  ${i + 1}  [${state}]  ${hook.event}${hook.match ? `:${hook.match}` : ""}  ${hook.command}\n       ${lastText}`
      })
      return [
        `hooks — ${source ? `${source.scope} config (${source.path})` : "source file unknown"}:`,
        ...lines,
        "",
        "/hooks <n> to enable/disable",
      ].join("\n")
    },
    toggleHook: (indexArg) => {
      const hooks = config().hooks ?? []
      const n = Number(indexArg)
      if (!Number.isInteger(n) || n < 1 || n > hooks.length) {
        push({ kind: "error", text: `no hook #${indexArg} — /hooks to list` })
        return
      }
      const hook = hooks[n - 1]
      if (!hook) {
        push({ kind: "error", text: `no hook #${indexArg} — /hooks to list` })
        return
      }
      const nextEnabled = hook.enabled === false
      try {
        const result = setHookEnabled(n - 1, nextEnabled, { cwd: props.cwd, home })
        if (!result.ok) {
          push({
            kind: "error",
            text: `${result.path} has comments — edit it by hand:\n  ${result.snippet}`,
          })
          return
        }
        setConfig(loadConfig({ cwd: props.cwd, home }))
        push({
          kind: "info",
          text: `hook #${n} (${hook.event} ${hook.command}) ${nextEnabled ? "enabled" : "disabled"} — ${result.path}`,
        })
      } catch (error) {
        push({ kind: "error", text: `toggle failed: ${String(error)}` })
      }
    },
    initProject: () => {
      submit(
        "Analyze this repository: read the README, package manifests, build/test scripts, and the main entry points (use glob/read/explore — stay efficient). Then use the memory tool with scope 'project' to store up to 5 terse durable facts: exact build/test/lint commands, architecture invariants, and conventions. Finish with a one-paragraph orientation summary.",
        "internal",
      )
    },
    undo: async () => {
      const { header, events } = SessionJournal.replay(session.journal.path)
      let snapshotIndex = -1
      let tree = ""
      let untracked: string[] | undefined
      events.forEach((event, index) => {
        if (event.type === "turn.snapshot" && event.callId === undefined) {
          snapshotIndex = index
          tree = event.tree
          untracked = event.untracked
        }
      })
      if (snapshotIndex < 0) {
        push({
          kind: "error",
          text: "nothing to undo — snapshots are taken before each turn (git repos only)",
        })
        return
      }
      const restored = await restoreSnapshot(props.cwd, tree, { untracked })
      if (!restored) {
        push({ kind: "error", text: "undo failed — could not restore the snapshot tree" })
        return
      }
      session.journal.append({ type: "session.rewound", toIndex: snapshotIndex, time: now() })
      const after = SessionJournal.replay(session.journal.path)
      setMessages(timelineToMessages(project(header, after.events).timeline))
      setStatus("")
      push({
        kind: "info",
        text:
          untracked !== undefined
            ? "undone — files and conversation reverted to before the last turn"
            : "undone — files and conversation reverted to before the last turn (files created since are not deleted — snapshot predates this fix)",
      })
    },
    rewind: () => {
      const { events } = SessionJournal.replay(session.journal.path)
      const checkpoints: { index: number; event: SnapshotEvent }[] = []
      events.forEach((event, index) => {
        if (event.type === "turn.snapshot") checkpoints.push({ index, event })
      })
      if (checkpoints.length === 0) {
        push({
          kind: "error",
          text: "nothing to rewind — snapshots are taken before turns and mutating tool calls (git repos only)",
        })
        return
      }
      setPicker({
        title: "rewind to checkpoint — ↑↓ · Enter select · Esc",
        items: [...checkpoints].reverse().map((c) => ({
          label: checkpointLabel(c.event),
          value: String(c.index),
        })),
        index: 0,
        filter: "",
        onPick: (value) => {
          const chosen = checkpoints.find((c) => String(c.index) === value)
          if (!chosen) return
          setPicker({
            title: `restore "${checkpointLabel(chosen.event)}" — pick what to revert`,
            items: [
              { label: "files only", value: "files" },
              { label: "conversation only", value: "conversation" },
              { label: "both", value: "both" },
            ],
            index: 2,
            filter: "",
            onPick: (mode) => {
              void performRewind(chosen, mode as "files" | "conversation" | "both")
            },
          })
        },
      })
    },
    exportTranscript: () => {
      try {
        const markdown = exportSessionMarkdown(session.journal.path)
        const file = join(props.cwd, `butterfly-${session.journal.header.sessionId.slice(0, 8)}.md`)
        writeFileSync(file, markdown)
        push({ kind: "info", text: `exported to ${file}` })
      } catch (error) {
        push({ kind: "error", text: `export failed: ${String(error)}` })
      }
    },
    review: async (arg) => {
      const ref = modelRef()
      if (!ref) {
        push({ kind: "error", text: "no model configured" })
        return
      }
      push({ kind: "info", text: "reviewing…" })
      setBusy(true)
      try {
        const diffOpts = parseReviewArg(arg)
        const result = await runReview(props.cwd, taskToolOpts, diffOpts)
        if (result.failure) {
          push({ kind: "error", text: `git failed: ${describeGitFailure(result.failure)}` })
          return
        }
        if (!result.journalPath) {
          push({ kind: "info", text: result.summary })
          return
        }
        const event = journalReview(session.journal, result, describeReviewScope(diffOpts))
        if (event) push(reviewMessage(event))
      } catch (error) {
        push({
          kind: "error",
          text: `review failed: ${error instanceof Error ? error.message : String(error)}`,
        })
      } finally {
        setBusy(false)
        drainQueue()
      }
    },
    commit: async () => {
      if (planMode()) {
        push({ kind: "error", text: "plan mode is read-only — /plan to exit first" })
        return
      }
      const ref = modelRef()
      if (!ref) {
        push({ kind: "error", text: "no model configured" })
        return
      }
      try {
        let result = await generateCommitMessage({
          cwd: props.cwd,
          provider: freshProvider(),
          model: config().small_model ?? ref,
        })
        if (result.failure) {
          push({ kind: "error", text: `git failed: ${describeGitFailure(result.failure)}` })
          return
        }
        if (result.nothingStaged) {
          const decision = await askApproval("nothing staged — stage all tracked modifications?")
          if (decision !== "allow") {
            push({ kind: "info", text: "commit cancelled — nothing staged" })
            return
          }
          const staged = await stageAllTracked(props.cwd)
          if (!staged) {
            push({ kind: "error", text: "staging failed — see `git status` for details" })
            return
          }
          result = await generateCommitMessage({
            cwd: props.cwd,
            provider: freshProvider(),
            model: config().small_model ?? ref,
          })
          if (result.nothingStaged) {
            push({ kind: "info", text: "still nothing staged after `git add -u`" })
            return
          }
        }
        push({ kind: "info", text: `commit message:\n\n${result.message}` })
        const path = writeCommitMessageFile(props.cwd, result.message)
        const commitRules = config().permissions ?? TUI_DEFAULT_RULES
        const commitResult = await registry.run(
          "bash",
          { command: `git commit -F "${path}"` },
          {
            cwd: props.cwd,
            rules: commitRules,
            ask: (request) => askPermission(request, commitRules),
            state,
          },
        )
        push({
          kind: commitResult.isError ? "error" : "info",
          text: commitResult.output,
        })
      } catch (error) {
        push({
          kind: "error",
          text: `commit failed: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    },
    pasteImage: async () => {
      const saved = await saveClipboardImage(props.cwd)
      if (!saved) {
        push({ kind: "info", text: "no image on the clipboard (or the clipboard shim failed)" })
        return
      }
      setAttachedImages((imgs) => [
        ...imgs,
        { path: saved, mediaType: mediaTypeForPath(saved) ?? "image/png" },
      ])
      push({ kind: "info", text: `attached ${basename(saved)} from the clipboard` })
    },
  }

  const handleSetupSubmit = (stage: SetupStage, value: string) => {
    if (stage.stage === "provider") {
      const trimmed = value.trim().toLowerCase()
      const byNumber = /^[1-9]$/.test(trimmed) ? PROVIDERS[Number(trimmed) - 1] : undefined
      const choice = byNumber ?? PROVIDERS.find((p) => p.id === trimmed)
      if (!choice) {
        push({
          kind: "error",
          text: `Unknown provider "${value}". Type a number 1-${PROVIDERS.length} or a name.`,
        })
        return
      }
      const next: SetupStage = choice.needsKey
        ? { stage: "key", provider: choice.id }
        : { stage: "model", provider: choice.id }
      setSetup(next)
      if (next.stage === "model") void modelListText(choice.id).then(setSetupModels)
      return
    }
    if (stage.stage === "key") {
      const key = value.trim()
      setSetup({ stage: "model", provider: stage.provider, ...(key ? { key } : {}) })
      setSetupModels("fetching available models…")
      void modelListText(stage.provider, key || undefined).then(setSetupModels)
      return
    }
    // model stage
    const modelId = value.trim()
    if (modelId === "") {
      push({ kind: "error", text: "Model id cannot be empty." })
      return
    }
    try {
      const path = saveGlobalConfig(
        {
          model: `${stage.provider}/${modelId}`,
          ...(stage.key ? { providers: { [stage.provider]: { apiKey: stage.key } } } : {}),
        },
        { home },
      )
      setConfig(loadConfig({ cwd: props.cwd, home }))
      setSetup(null)
      setSetupModels("")
      refreshCtxLimit()
      push({ kind: "info", text: `Saved to ${path}` })
      push({ kind: "info", text: `Ready on ${stage.provider}/${modelId} — describe a task below.` })
      if (stage.provider !== "ollama" && stage.provider !== "lmstudio") {
        if (!catalog.lookup(stage.provider, modelId)) {
          push({
            kind: "info",
            text: `note: "${stage.provider}/${modelId}" is not in the models.dev catalog — double-check the id if requests fail (/setup to change it).`,
          })
        }
      }
    } catch (error) {
      push({
        kind: "error",
        text: `Could not save config: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  const submit = (value: string, source: "composer" | "internal" = "composer") => {
    if (picker()) return
    const rawTask = value.trim()
    if (rawTask === "" || pendingAsk()) return
    const task = expandComposerText(rawTask, pasteChips())
    if (source === "composer") {
      const orphans = unreferencedChips(rawTask, pasteChips())
      if (orphans.length > 0) {
        const which = orphans.map((n) => `#${n}`).join(", ")
        push({
          kind: "info",
          text: `⚠ paste chip${orphans.length === 1 ? "" : "s"} ${which} ${orphans.length === 1 ? "is" : "are"} no longer in the message — that text was NOT sent`,
        })
      }
    }
    if (busy()) {
      setQueued([...queued(), task])
      setDraft("")
      setPasteChips(new Map())
      push({ kind: "info", text: `⧗ queued (${queued().length}): ${task.slice(0, 80)}` })
      return
    }
    setDraft("")
    setCmdIndex(0)
    setPasteChips(new Map())

    const stage = setup()
    if (stage) {
      handleSetupSubmit(stage, task)
      return
    }

    setHistory([...history().slice(-99), task])
    historyPos = -1

    let modelTask = task
    const visibleMatches = task.startsWith("/") ? commandMatches(task) : []
    if (visibleMatches.length > 0) {
      const selected = visibleMatches[Math.min(cmdIndex(), visibleMatches.length - 1)]
      if (selected) {
        const typedArg = task.slice(1 + (task.slice(1).split(/\s+/)[0]?.length ?? 0)).trim()
        setCmdIndex(0)
        void selected.run(typedArg, actions)
        return
      }
    }
    const match = findCommand(task)
    if (match) {
      if ("command" in match) {
        void match.command.run(match.arg, actions)
        return
      }
      // Custom commands (.butterfly/commands/*.md) fill the gap.
      const token = task.slice(1).split(/\s+/)[0]?.toLowerCase() ?? ""
      const custom = customCommands.find((c) => c.name === token)
      if (custom) {
        modelTask = expandTemplate(custom.template, task.slice(1 + token.length).trim())
      } else if (match.suggestions.length > 0) {
        push({
          kind: "info",
          text: `did you mean: ${match.suggestions.map((c) => `/${c.name}`).join(", ")}?`,
        })
        return
      } else {
        const known = customCommands.map((c) => `/${c.name}`).join(", ")
        push({
          kind: "error",
          text: `unknown command ${task.split(/\s/)[0]} — /help lists commands${known ? `; custom: ${known}` : ""}`,
        })
        return
      }
    }

    push({ kind: "user", text: task })
    const ref = modelRef()
    if (!ref) {
      push({ kind: "info", text: "No model configured — run /setup first." })
      return
    }

    const pendingImages = attachedImages()
    setAttachedImages([])
    let turnImages: ImageRef[] = []
    if (pendingImages.length > 0) {
      const prepared = prepareImageAttachments(
        pendingImages.map((img) => img.path),
        props.cwd,
      )
      turnImages = prepared.images
      for (const notice of prepared.notices) push({ kind: "info", text: notice })
    }

    let taskText = planMode() ? `${PLAN_PREFIX}\n\n${modelTask}` : modelTask

    const mentions = expandMentions(props.cwd, modelTask)
    const mentionBlock = renderMentionBlock(mentions)
    if (mentionBlock !== "") {
      taskText = `${mentionBlock}\n\n${taskText}`
    }
    if (firstTurn && graph) {
      const mentionedWords = task.split(/[^A-Za-z0-9_]+/).filter((word) => word.length >= 3)
      const skeleton = buildSkeleton(graph, {
        mentionedIdents: mentionedWords,
        chatFiles: mentions.map((m) => m.path),
      })
      if (skeleton !== "") {
        taskText = `[repository map — ranked symbols; use explore/read for bodies]\n${skeleton}\n\n${taskText}`
      }
    }
    firstTurn = false
    setBusy(true)
    abort = new AbortController()
    const limit = ctxLimit()
    const attentionState = () => ({
      focus: focused() ? ("focused" as const) : ("blurred" as const),
      cwd: props.cwd,
    })
    const attentionConfig = () => ({ notifications: config().notifications ?? true })
    applyAttention(decideAttention({ kind: "turn.start" }, attentionState(), attentionConfig()))
    let turnDetail: string | undefined
    const turnRules = planMode() ? PLAN_RULES : (config().permissions ?? TUI_DEFAULT_RULES)
    runUserTurn(
      {
        provider: freshProvider(),
        registry,
        journal: session.journal,
        rules: turnRules,
        model: ref,
        system: frozenSystem(ref),
        cwd: props.cwd,
        state,
        signal: abort.signal,
        onEvent,
        createSnapshot,
        listUntracked,
        ...(modelCost() ? { cost: modelCost() } : {}),
        ...(config().maxSpendUSD !== undefined ? { maxSpendUSD: config().maxSpendUSD } : {}),
        ...(config().hooks?.length ? { hooks: config().hooks } : {}),
        ...(reasoning() !== undefined ? { reasoning: reasoning() } : {}),
        ...(limit ? { limits: { context: limit } } : {}),
        ...(config().small_model ? { smallModel: config().small_model } : {}),
        imageInputSupported: imageInputSupported(),
        ask: (request) => askPermission(request, turnRules),
      },
      taskText,
      turnImages.length > 0 ? { images: turnImages } : undefined,
    )
      .then((outcome) => {
        setSessionCost((c) => c + outcome.costUSD)
        setStatus(
          `in ${outcome.usage.input} · out ${outcome.usage.output} · cached ${outcome.usage.cacheRead} · ${outcome.steps} steps`,
        )
        void (async () => {
          try {
            episodic.indexJournal(session.journal.path)
          } catch {
            // non-fatal
          }
          const small = config().small_model
          if (small) {
            await reviewTurn({
              provider: freshProvider(),
              model: small,
              journal: session.journal,
              paths,
            })
          }
        })()
      })
      .catch((error: unknown) => {
        turnDetail = error instanceof Error ? error.message : String(error)
        push({
          kind: "error",
          text: `Error: ${turnDetail}`,
        })
      })
      .finally(() => {
        applyAttention(
          decideAttention(
            { kind: "turn.end", detail: turnDetail },
            attentionState(),
            attentionConfig(),
          ),
        )
        setBusy(false)
        drainQueue()
      })
  }

  /** Anything that held `busy` must hand the queue on, in order. */
  function drainQueue(): void {
    const [next, ...rest] = queued()
    if (next !== undefined) {
      setQueued(rest)
      setTimeout(() => submit(next, "internal"), 0)
    }
  }

  usePaste((event) => {
    if (setup() || picker() || pagerOpen()) return
    const text = decodePasteBytes(event.bytes)
    if (detectAttachableImage(props.cwd, draft() + text)) return
    if (!shouldChip(text)) return
    event.preventDefault()
    const created = addPasteChip(draft(), text, pasteChips(), nextChipNumber)
    setDraft(created.draftWithChip)
    setPasteChips(created.payloads)
    nextChipNumber = created.nextChipNumber
    setCmdIndex(0)
    historyPos = -1
  })

  let interruptArmed = false
  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      key.preventDefault()
      if (busy() && abort && !interruptArmed) {
        interruptArmed = true
        abort.abort()
        pendingAsk()?.resolve("deny")
        push({ kind: "info", text: "(turn interrupted — Ctrl+C again to quit)" })
        setTimeout(() => {
          interruptArmed = false
        }, 3_000)
      } else {
        quit()
      }
      return
    }
    const ask = pendingAsk()
    if (ask) {
      key.preventDefault()
      if (key.name === "y") ask.resolve("allow")
      if (key.name === "n" || key.name === "escape") ask.resolve("deny")
      if (key.name === "a" && ask.quickAdd) {
        applyQuickAdd(ask.quickAdd)
        ask.resolve("allow")
      }
      return
    }
    if (key.ctrl && key.name === "o" && !setup()) {
      key.preventDefault()
      if (pagerOpen()) closePager()
      else if (!picker()) openPager()
      return
    }
    if (pagerOpen()) {
      key.preventDefault()
      if (pagerSearchActive()) {
        if (key.name === "return" || key.name === "enter") {
          setPagerSearchActive(false)
        } else if (key.name === "escape") {
          setPagerSearchActive(false)
          runPagerSearch("")
        } else if (key.name === "backspace") {
          runPagerSearch(pagerQuery().slice(0, -1))
        } else if (
          key.sequence &&
          key.sequence.length === 1 &&
          !key.ctrl &&
          !key.meta &&
          key.sequence >= " "
        ) {
          runPagerSearch(pagerQuery() + key.sequence)
        }
        return
      }
      if (key.name === "escape" || (key.sequence === "q" && !key.ctrl && !key.meta)) {
        closePager()
        return
      }
      if (key.sequence === "/" && !key.ctrl && !key.meta) {
        setPagerSearchActive(true)
        return
      }
      if (key.sequence === "n" && !key.ctrl && !key.meta && pagerMatches().length > 0) {
        const line = stepLine(pagerMatches(), pagerLine(), 1)
        setPagerLine(line)
        pagerScroll?.scrollTo(line)
        return
      }
      if (key.sequence === "N" && !key.ctrl && !key.meta && pagerMatches().length > 0) {
        const line = stepLine(pagerMatches(), pagerLine(), -1)
        setPagerLine(line)
        pagerScroll?.scrollTo(line)
        return
      }
      if (key.sequence === "}" && !key.ctrl && !key.meta) {
        const line = stepLine(pagerDoc().promptLines, pagerLine(), 1)
        if (line >= 0) {
          setPagerLine(line)
          pagerScroll?.scrollTo(line)
        }
        return
      }
      if (key.sequence === "{" && !key.ctrl && !key.meta) {
        const line = stepLine(pagerDoc().promptLines, pagerLine(), -1)
        if (line >= 0) {
          setPagerLine(line)
          pagerScroll?.scrollTo(line)
        }
        return
      }
      if (key.sequence === "[" && !key.ctrl && !key.meta) {
        pagerDumpScrollback()
        return
      }
      if (key.sequence === "v" && !key.ctrl && !key.meta) {
        void pagerExportAndEdit()
        return
      }
      return
    }
    const activePicker = picker()
    if (activePicker) {
      key.preventDefault()
      const visible = pickerItems()
      if (key.name === "down") {
        setPicker({
          ...activePicker,
          index: Math.min(Math.max(0, visible.length - 1), activePicker.index + 1),
        })
      } else if (key.name === "up") {
        setPicker({ ...activePicker, index: Math.max(0, activePicker.index - 1) })
      } else if (key.name === "return" || key.name === "enter") {
        const item = visible[Math.min(activePicker.index, visible.length - 1)]
        setPicker(null)
        if (item) activePicker.onPick(item.value)
      } else if (key.name === "escape") {
        setPicker(null)
      } else if (key.name === "backspace") {
        setPicker({ ...activePicker, filter: activePicker.filter.slice(0, -1), index: 0 })
      } else if (
        key.sequence &&
        key.sequence.length === 1 &&
        !key.ctrl &&
        !key.meta &&
        key.sequence >= " "
      ) {
        // type-to-filter
        setPicker({ ...activePicker, filter: activePicker.filter + key.sequence, index: 0 })
      }
      return
    }
    if (key.ctrl && key.name === "v" && !setup() && !busy()) {
      void actions.pasteImage()
    }
    if (!setup() && !pagerOpen() && !picker() && !pendingAsk()) {
      if (key.sequence === "\n" || key.name === "linefeed" || (key.ctrl && key.name === "j")) {
        key.preventDefault()
        setDraft(draft() + NEWLINE_MARKER)
        return
      }
      if ((key.name === "return" || key.name === "kpenter") && draft().endsWith("\\")) {
        key.preventDefault()
        setDraft(`${draft().slice(0, -1)}${NEWLINE_MARKER}`)
        return
      }
      if (
        key.name === "backspace" &&
        composerRef !== undefined &&
        !composerRef.hasSelection() &&
        composerRef.cursorOffset === draft().length
      ) {
        const removed = removeTrailingChip(draft(), pasteChips())
        if (removed) {
          key.preventDefault()
          setDraft(removed.draft)
          setPasteChips(removed.payloads)
          return
        }
      }
    }
    if (!setup() && !busy() && (draft() === "" || historyPos >= 0)) {
      const entries = history()
      if (key.name === "up" && entries.length > 0) {
        historyPos = historyPos < 0 ? entries.length - 1 : Math.max(0, historyPos - 1)
        setDraft(toComposerDraft(entries[historyPos] ?? ""))
        return
      }
      if (key.name === "down" && historyPos >= 0) {
        historyPos += 1
        if (historyPos >= entries.length) {
          historyPos = -1
          setDraft("")
        } else {
          setDraft(toComposerDraft(entries[historyPos] ?? ""))
        }
        return
      }
    }

    const matches = cmdList()
    if (matches.length > 0) {
      if (key.name === "down") {
        setCmdIndex((i) => Math.min(matches.length - 1, i + 1))
        return
      }
      if (key.name === "up") {
        setCmdIndex((i) => Math.max(0, i - 1))
        return
      }
      if (key.name === "tab") {
        const command = matches[Math.min(cmdIndex(), matches.length - 1)]
        if (command) {
          setDraft(`/${command.name} `)
          setCmdIndex(0)
        }
        return
      }
    }
    if (key.name === "escape" && setup() && config().model) {
      setSetup(null)
      return
    }
  })

  const mark = renderWordmark()
  const markMode = () => wordmarkMode(dimensions().width)
  const showBigMark = () => messages().length === 0 && !setup() && markMode() !== "plain"
  const markRows = () => [0, 1, 2, 3, 4, 5]

  const ctxGauge = () => {
    const limit = ctxLimit()
    const used = ctxUsed()
    if (!limit) return used > 0 ? `ctx ${(used / 1000).toFixed(1)}k` : ""
    const pct = Math.min(100, Math.round((used / limit) * 100))
    return `ctx ${pct}% of ${Math.round(limit / 1000)}k`
  }
  const ctxDanger = () => {
    const limit = ctxLimit()
    return limit !== undefined && ctxUsed() / limit > 0.8
  }

  const setupPrompt = (): string => {
    const stage = setup()
    if (!stage) return ""
    if (stage.stage === "provider") return "provider number or name, then Enter"
    if (stage.stage === "key") return `${stage.provider} API key (Enter to skip)`
    const example = PROVIDERS.find((p) => p.id === stage.provider)?.example ?? "model-id"
    return `model id, e.g. ${example}`
  }

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      <box flexShrink={0} height={1} paddingLeft={1} flexDirection="row">
        <text fg={MUTED}>butterfly </text>
        <text>
          <b>code</b>
        </text>
        <text fg={MUTED}>{modelRef() ? `  ·  ${modelRef()}` : "  ·  not configured"}</text>
        <Show when={reasoning()}>
          <text fg={ACCENT}>{`  ·  think:${reasoning()}`}</text>
        </Show>
        <Show when={planMode()}>
          <text fg={WARN}>{"  ·  PLAN (read-only)"}</text>
        </Show>
      </box>

      <box flexGrow={1} minHeight={0} paddingLeft={2} paddingRight={2}>
        <Show
          when={!pagerOpen()}
          fallback={
            <PagerView
              doc={pagerDoc()}
              query={pagerQuery()}
              searchActive={pagerSearchActive()}
              matches={pagerMatches()}
              currentLine={pagerLine()}
              notice={pagerNotice()}
              scrollRef={(r: ScrollBoxRenderable) => {
                pagerScroll = r
              }}
            />
          }
        >
          <Show
            when={!setup()}
            fallback={
              <box flexGrow={1} flexDirection="column" paddingTop={1}>
                <text>
                  <b>setup</b>
                </text>
                <box marginTop={1} flexDirection="column">
                  <Show when={setup()?.stage === "provider"}>
                    <text fg={MUTED}>Pick a provider (type its number or name, then Enter):</text>
                    <For each={PROVIDERS}>
                      {(choice, index) => (
                        <text>
                          {`  ${index() + 1}  ${choice.id}${choice.needsKey ? "" : "  (no key needed)"}`}
                        </text>
                      )}
                    </For>
                  </Show>
                  <Show when={setup()?.stage === "key"}>
                    <text fg={MUTED}>
                      Paste your API key and press Enter. It is stored in
                      ~/.config/butterfly/butterfly.jsonc (visible while typing).
                    </text>
                  </Show>
                  <Show when={setup()?.stage === "model"}>
                    <text fg={MUTED}>{`Model id for this provider — e.g. ${
                      PROVIDERS.find((p) => p.id === (setup() as { provider?: string }).provider)
                        ?.example ?? "model-id"
                    }`}</text>
                    <Show when={setupModels() !== ""}>
                      <box marginTop={1}>
                        <text fg={MUTED}>{setupModels()}</text>
                      </box>
                    </Show>
                  </Show>
                </box>
                <box marginTop={1} flexDirection="column">
                  <For each={messages().slice(-3)}>
                    {(message) => (
                      <text fg={message.kind === "error" ? ERROR : MUTED}>{message.text}</text>
                    )}
                  </For>
                </box>
              </box>
            }
          >
            <Show
              when={!showBigMark()}
              fallback={
                <box
                  flexGrow={1}
                  justifyContent="center"
                  alignItems="center"
                  flexDirection="column"
                >
                  <Show
                    when={markMode() === "single"}
                    fallback={
                      <box flexDirection="column" alignItems="center">
                        <For each={markRows()}>
                          {(row) => <text fg={MUTED}>{mark.left[row]}</text>}
                        </For>
                        <box marginTop={1} flexDirection="column" alignItems="center">
                          <For each={markRows()}>
                            {(row) => (
                              <text>
                                <b>{mark.right[row]}</b>
                              </text>
                            )}
                          </For>
                        </box>
                      </box>
                    }
                  >
                    <box flexDirection="column">
                      <For each={markRows()}>
                        {(row) => (
                          <box flexDirection="row">
                            <text fg={MUTED}>{mark.left[row]}</text>
                            <text>{"  "}</text>
                            <text>
                              <b>{mark.right[row]}</b>
                            </text>
                          </box>
                        )}
                      </For>
                    </box>
                  </Show>
                  <box marginTop={1}>
                    <text fg={MUTED}>the harness-first coding agent — /help for commands</text>
                  </box>
                </box>
              }
            >
              <scrollbox
                ref={(r: ScrollBoxRenderable) => {
                  scroll = r
                }}
                stickyScroll
                stickyStart="bottom"
                flexGrow={1}
              >
                <For each={messages()}>
                  {(message, index) => (
                    <Show
                      when={message.kind === "assistant"}
                      fallback={
                        <box marginTop={message.kind === "user" ? 1 : 0} flexDirection="column">
                          <text
                            fg={
                              message.kind === "tool" || message.kind === "info"
                                ? MUTED
                                : message.kind === "error"
                                  ? ERROR
                                  : undefined
                            }
                          >
                            {message.kind === "user" ? `❯ ${message.text}` : message.text}
                          </text>
                          <Show when={message.diff}>
                            <box paddingLeft={2} flexShrink={0}>
                              <diff
                                diff={message.diff ?? ""}
                                view="unified"
                                syntaxStyle={SYNTAX}
                                filetype={filetypeOf(message.path)}
                                wrapMode="none"
                              />
                            </box>
                          </Show>
                        </box>
                      }
                    >
                      <Show when={stripThink(message.text).trim() !== ""}>
                        <box marginTop={1} flexShrink={0}>
                          <markdown
                            content={stripThink(message.text).trim()}
                            syntaxStyle={SYNTAX}
                            streaming={busy() && index() === messages().length - 1}
                            internalBlockMode="top-level"
                          />
                        </box>
                      </Show>
                    </Show>
                  )}
                </For>
              </scrollbox>
            </Show>
          </Show>
        </Show>
      </box>

      <Show when={pendingAsk()}>
        {(ask: Accessor<PendingAsk>) => (
          <box
            flexShrink={0}
            border
            borderStyle="rounded"
            borderColor={ACCENT}
            paddingLeft={1}
            flexDirection="row"
          >
            <text fg={ACCENT}>approve? </text>
            <text>{ask().text} </text>
            <text fg={MUTED}>[y]es / [n]o</text>
            <Show when={ask().quickAdd}>
              {(qa: Accessor<QuickAddOffer>) => (
                <text fg={MUTED}>{` / [a]lways ${qa().tool}: "${qa().pattern}"`}</text>
              )}
            </Show>
          </box>
        )}
      </Show>

      <Show when={picker()}>
        {(p: Accessor<{ title: string; index: number; filter: string }>) => {
          const items = () => pickerItems()
          const windowStart = () => Math.max(0, Math.min(p().index - 4, items().length - 9))
          return (
            <box
              flexShrink={0}
              border
              borderStyle="rounded"
              borderColor={ACCENT}
              paddingLeft={1}
              flexDirection="column"
            >
              <text fg={ACCENT}>{p().title}</text>
              <Show when={p().filter !== ""}>
                <text
                  fg={WARN}
                >{`  filter: ${p().filter}  (${items().length} match${items().length === 1 ? "" : "es"})`}</text>
              </Show>
              <Show
                when={items().length > 0}
                fallback={<text fg={MUTED}> no matches — Backspace to widen</text>}
              >
                <For each={items().slice(windowStart(), windowStart() + 9)}>
                  {(item, i) => (
                    <box flexDirection="row">
                      <text fg={windowStart() + i() === p().index ? ACCENT : MUTED}>
                        {windowStart() + i() === p().index ? "❯ " : "  "}
                      </text>
                      <text fg={windowStart() + i() === p().index ? undefined : MUTED}>
                        {item.label}
                      </text>
                    </box>
                  )}
                </For>
              </Show>
              <Show when={items().length > 9}>
                <text fg={MUTED}>{`  … ${items().length} total`}</text>
              </Show>
            </box>
          )
        }}
      </Show>

      <Show when={cmdList().length > 0}>
        <box
          flexShrink={0}
          border
          borderStyle="rounded"
          borderColor={MUTED}
          paddingLeft={1}
          flexDirection="column"
        >
          <For
            each={(() => {
              const start = Math.max(0, Math.min(cmdIndex() - 4, cmdList().length - 8))
              return cmdList()
                .slice(start, start + 8)
                .map((command, offset) => ({ command, absolute: start + offset }))
            })()}
          >
            {(row) => (
              <box flexDirection="row">
                <text fg={row.absolute === cmdIndex() ? ACCENT : MUTED}>
                  {row.absolute === cmdIndex() ? "❯ " : "  "}
                </text>
                <text fg={row.absolute === cmdIndex() ? undefined : MUTED}>
                  {`/${row.command.name}${row.command.args ? ` ${row.command.args}` : ""}`.padEnd(
                    18,
                  )}
                </text>
                <text fg={MUTED}>{row.command.description}</text>
              </box>
            )}
          </For>
          <text fg={MUTED}>
            {` ↑↓ select · Tab complete · Enter run${cmdList().length > 8 ? ` · ${cmdList().length} commands` : ""}`}
          </text>
        </box>
      </Show>

      <Show when={attachedImages().length > 0}>
        <box flexShrink={0} paddingLeft={1} flexDirection="row">
          <text fg={ACCENT}>
            {`📎 ${attachedImages().length} image${attachedImages().length === 1 ? "" : "s"}: `}
          </text>
          <text fg={MUTED}>
            {attachedImages()
              .map((img) => basename(img.path))
              .join(", ")}
          </text>
        </box>
      </Show>

      <box flexShrink={0} border borderStyle="rounded" paddingLeft={1}>
        <input
          ref={(r: InputRenderable) => {
            composerRef = r
          }}
          focused={!picker() && !pagerOpen()}
          value={draft()}
          onInput={(value: string) => {
            const previous = draft()
            if (!setup() && !busy() && !picker()) {
              const detected = detectAttachableImage(props.cwd, value)
              if (detected) {
                setAttachedImages((imgs) => [
                  ...imgs,
                  { path: detected.path, mediaType: detected.mediaType },
                ])
                setDraft(detected.remaining)
                setCmdIndex(0)
                historyPos = -1
                return
              }
            }
            if (!setup() && !picker() && !pagerOpen()) {
              const inserted = insertedSpan(previous, value)
              if (inserted.length >= PASTE_RATE_HEURISTIC_CHARS && shouldChip(inserted)) {
                const created = addPasteChip(previous, inserted, pasteChips(), nextChipNumber)
                setDraft(created.draftWithChip)
                setPasteChips(created.payloads)
                nextChipNumber = created.nextChipNumber
                setCmdIndex(0)
                historyPos = -1
                return
              }
            }
            setDraft(value)
            setCmdIndex(0)
            historyPos = -1
            if (!setup() && !busy() && !picker() && isMentionTrigger(previous, value)) {
              openMentionPicker()
            }
          }}
          onSubmit={() => submit(draft())}
          placeholder={
            setup()
              ? setupPrompt()
              : busy()
                ? "working… (Ctrl+C to interrupt)"
                : "describe a task — /help for commands"
          }
        />
      </box>

      <box flexShrink={0} height={1} paddingLeft={1} flexDirection="row">
        <text fg={busy() ? ACCENT : MUTED}>
          {busy() ? `${SPINNER[spin()]} thinking… ` : status() ? `${status()}  ` : ""}
        </text>
        <Show when={ctxGauge() !== ""}>
          <text fg={ctxDanger() ? WARN : MUTED}>{ctxGauge()}</text>
        </Show>
        <Show when={sessionCost() > 0}>
          <text fg={MUTED}>{`  ·  ${formatUSD(sessionCost())}`}</text>
        </Show>
        <Show when={queued().length > 0}>
          <text fg={WARN}>{`  ·  ⧗ ${queued().length} queued`}</text>
        </Show>
      </box>
    </box>
  )
}
