import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, isAbsolute, join } from "node:path"
import {
  AiSdkProvider,
  type AttentionAction,
  applyMemoryOp,
  BG_TASKS_STATE_KEY,
  BgTaskRegistry,
  type ButterflyConfig,
  bashTool,
  buildSkeleton,
  buildSystem,
  CodeGraph,
  clearProgressOsc,
  compactSession,
  computeCostUSD,
  createExploreTool,
  createMcpTool,
  createMemoryTool,
  createModelResolver,
  createSkillTool,
  createSnapshot,
  createTaskTool,
  createWebTool,
  decideAttention,
  deleteSkill,
  describeEvolution,
  describeGitFailure,
  describeProviderError,
  describeReviewScope,
  discardWorktree,
  doctor,
  EpisodicIndex,
  editTool,
  evolveAfterTurn,
  expandMentions,
  exportSessionMarkdown,
  fetchProviderModels,
  focusedSkeleton,
  forgetMemoryLine,
  forkSession,
  formatUSD,
  frecencyStorePath,
  type Gate,
  type GraphDb,
  generateCommitMessage,
  globTool,
  grepTool,
  type ImageRef,
  journalReview,
  type LoopEvent,
  listMentionCandidates,
  listSessions,
  listSkills,
  listUntracked,
  listWorktrees,
  loadConfig,
  loadFrecency,
  loadMemory,
  locateHooksSource,
  MAX_CONCURRENT_WORKTREES,
  McpHub,
  ModelsCatalog,
  mediaTypeForPath,
  memoryPaths,
  mergeWorktree,
  moduleOverview,
  mutatingSubagentRegistry,
  now,
  type PermissionRules,
  type ProviderErrorInfo,
  parseModelRef,
  parseReviewArg,
  planQuickAdd,
  preloadHandoff,
  prepareImageAttachments,
  presetBaseURL,
  presetEnvKey,
  project,
  promoteSkill,
  type ReasoningEffort,
  type ReviewEvent,
  type RunnerEvent,
  rankByFrecency,
  readSkill,
  readTool,
  renderDoctorReport,
  renderMemoryView,
  renderMentionBlock,
  renderSkillsView,
  restoreSnapshot,
  runCommand,
  runHandoffTurn,
  runHooks,
  runLoop,
  runReview,
  runUserTurn,
  SELF_NAMED_PROVIDERS,
  SessionJournal,
  type SessionSummary,
  safeRewindIndex,
  saveGlobalConfig,
  saveHandoff,
  setHookEnabled,
  setPermissionRule,
  skillStatus,
  skillsIndex,
  stageAllTracked,
  type TaskToolOptions,
  ToolRegistry,
  todoTool,
  touchFrecency,
  type Usage,
  WorkQueue,
  withFrecencyTouch,
  worktreeStatus,
  writeCommitMessageFile,
} from "@butterfly/core"
import { decodePasteBytes, type InputRenderable, type ScrollBoxRenderable } from "@opentui/core"
import {
  onBlur,
  onFocus,
  useKeyboard,
  usePaste,
  useRenderer,
  useSelectionHandler,
  useTerminalDimensions,
} from "@opentui/solid"
import { type Accessor, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { capOsc52Text, saveClipboardImage } from "./clipboard"
import {
  type CommandActions,
  commandMatches,
  commandMatchLabel,
  commandMatchReason,
  expandTemplate,
  findCommand,
  loadCustomCommands,
  type SlashCommand,
} from "./commands"
import {
  COPY_UNSUPPORTED_TEXT,
  copyStatusText,
  formatCommandBody,
  formatDuration,
  formatToolResult,
  humanizeTokens,
  metersFitAt,
  middleEllipsize,
  splitThink,
  turnMarker,
} from "./format"
import {
  applyLoopEvent,
  askBearingRules,
  askRulesWarning,
  dirtyLoopLines,
  dirtyTreeOverride,
  dirtyTreeRefusal,
  INITIAL_LOOP_CARD,
  type LoopCardState,
  loopCardText,
  loopSpendCredit,
  loopSummaryText,
  spendCapNotice,
} from "./loop-card"
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
import {
  BUILTIN_THEMES,
  listThemeNames,
  loadCustomThemes,
  resolveTheme,
  SYNTAX,
  setThemeTokens,
  themeTokens,
} from "./theme"
import { renderWordmark, wordmarkMode } from "./wordmark"

interface TodoMeta {
  text: string
  status: "pending" | "in_progress" | "completed"
}

interface Message {
  kind: "user" | "assistant" | "tool" | "info" | "error" | "thinking"
  text: string
  /** Unified diff for edit results — rendered with the diff element. */
  diff?: string
  path?: string
  todos?: TodoMeta[]
  command?: string
  exitCode?: number
  commandBody?: string
  errorInfo?: ProviderErrorInfo
  thinkStartedAt?: number
  thinkClosedAt?: number
  isCall?: boolean
  structured?: boolean
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
    if (event.type === "message.user")
      restored.push(
        event.synthetic === true
          ? { kind: "info", text: "auto-continue: the harness nudged the model to keep going" }
          : { kind: "user", text: event.text },
      )
    else if (event.type === "message.assistant") {
      const split = splitThink(event.text)
      if (split.rest.trim() !== "" || split.thinking !== "") {
        restored.push({ kind: "assistant", text: event.text })
      }
    } else if (event.type === "tool.call") restored.push(toolCallMessage(event.name, event.input))
    else if (event.type === "tool.result")
      restored.push(toolResultMessage(event.output, event.isError, event.meta))
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

const TODO_STATUSES = new Set(["pending", "in_progress", "completed"])

function metaTodos(meta: unknown): { todos: TodoMeta[] } | undefined {
  if (!meta || typeof meta !== "object" || !("todos" in meta)) return undefined
  const raw = (meta as { todos: unknown }).todos
  if (!Array.isArray(raw)) return undefined
  const todos: TodoMeta[] = []
  for (const item of raw) {
    if (
      item &&
      typeof item === "object" &&
      typeof (item as { text?: unknown }).text === "string" &&
      TODO_STATUSES.has((item as { status?: unknown }).status as string)
    ) {
      todos.push(item as TodoMeta)
    } else {
      return undefined // one malformed item — refuse the whole card
    }
  }
  return { todos }
}

/** Duck-types the bash tool's UI-only `meta.command`/`meta.exitCode` (bash.ts). */
function metaBash(meta: unknown): { command: string; exitCode: number } | undefined {
  if (!meta || typeof meta !== "object" || !("command" in meta) || !("exitCode" in meta)) {
    return undefined
  }
  const m = meta as { command: unknown; exitCode: unknown }
  if (typeof m.command === "string" && typeof m.exitCode === "number") {
    return { command: m.command, exitCode: m.exitCode }
  }
  return undefined
}

function capAtTokenBoundary(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  const slice = text.slice(0, maxLen)
  const boundary = Math.max(
    slice.lastIndexOf(","),
    slice.lastIndexOf(" "),
    slice.lastIndexOf(":"),
    slice.lastIndexOf("{"),
  )
  const cut = boundary > maxLen * 0.5 ? slice.slice(0, boundary) : slice
  return `${cut}…`
}

function toolCallArgs(name: string, input: unknown): string {
  const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {}
  const str = (value: unknown): string | undefined =>
    typeof value === "string" ? value : undefined
  if (name === "read" || name === "edit") {
    const path = str(args.file_path)
    if (path !== undefined) return path
  }
  if (name === "glob") {
    const pattern = str(args.pattern)
    if (pattern !== undefined) return pattern
  }
  if (name === "grep") {
    const pattern = str(args.pattern)
    if (pattern !== undefined) {
      const glob = str(args.glob)
      return glob ? `${pattern} ${glob}` : pattern
    }
  }
  return capAtTokenBoundary(JSON.stringify(input), 100)
}

function toolCallMessage(name: string, input: unknown): Message {
  return { kind: "tool", text: `${name} ${toolCallArgs(name, input)}`, isCall: true }
}

function toolResultMessage(output: string, isError: boolean, meta: unknown): Message {
  const bash = metaBash(meta)
  return {
    kind: isError ? "error" : "tool",
    text: `  ${formatToolResult(output, isError)}`,
    ...(metaDiff(meta) ?? {}),
    ...(metaTodos(meta) ?? {}),
    ...(bash
      ? {
          command: bash.command,
          exitCode: bash.exitCode,
          commandBody: formatCommandBody(output, isError),
        }
      : {}),
  }
}

function errorCardHeadline(info: ProviderErrorInfo): string {
  return `error: ${describeProviderError(info)}`
}

function errorCardDetail(info: ProviderErrorInfo, headline: string): string | undefined {
  const detail = info.detail
  if (detail === undefined || detail === "") return undefined
  return headline.includes(detail) ? undefined : detail
}

const TODO_GLYPH: Record<TodoMeta["status"], string> = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]",
}

function ThinkingBlock(props: {
  thinkingText: string
  open: boolean
  startedAt?: number
  closedAt?: number
  expanded: boolean
}) {
  const seconds = () =>
    props.startedAt !== undefined && props.closedAt !== undefined
      ? Math.max(0, Math.round((props.closedAt - props.startedAt) / 1000))
      : undefined
  return (
    <box flexDirection="column">
      <Show
        when={props.open}
        fallback={
          <text fg={themeTokens().muted}>
            {seconds() !== undefined ? `thought for ${seconds()}s` : "thought"}
          </text>
        }
      >
        <box flexDirection="column">
          <text fg={themeTokens().muted}>{"thinking…"}</text>
          <For each={props.thinkingText.split("\n").slice(-3)}>
            {(line) => <text fg={themeTokens().muted}>{`  ${line}`}</text>}
          </For>
        </box>
      </Show>
      <Show when={props.expanded && !props.open && props.thinkingText.trim() !== ""}>
        <box paddingLeft={2} flexDirection="column">
          <text fg={themeTokens().muted}>{props.thinkingText.trim()}</text>
        </box>
      </Show>
    </box>
  )
}

export function splitLabelValue(line: string): { label: string; value: string } | undefined {
  const match = line.match(/^(\s*\S.*?)( {2,})(\S.*)$/)
  if (!match) return undefined
  const [, label, gap, value] = match
  if (label === undefined || gap === undefined || value === undefined) return undefined
  return { label: `${label}${gap}`, value }
}

function MessageLine(props: { line: string; tone: string | undefined; structured: boolean }) {
  const split = () => (props.structured ? splitLabelValue(props.line) : undefined)
  return (
    <Show when={split()} fallback={<text fg={props.tone}>{props.line}</text>}>
      {(pair: Accessor<{ label: string; value: string }>) => (
        <box flexDirection="row">
          <text fg={themeTokens().muted}>{pair().label}</text>
          <text>{pair().value}</text>
        </box>
      )}
    </Show>
  )
}

function MessageLines(props: { text: string; tone: string | undefined; structured?: boolean }) {
  return (
    <box flexDirection="column">
      <For each={props.text.split("\n")}>
        {(line) => (
          <MessageLine line={line} tone={props.tone} structured={props.structured ?? false} />
        )}
      </For>
    </box>
  )
}

function ToolCallRow(props: { text: string }) {
  const spaceIndex = () => props.text.indexOf(" ")
  const name = () => (spaceIndex() === -1 ? props.text : props.text.slice(0, spaceIndex()))
  const args = () => (spaceIndex() === -1 ? "" : props.text.slice(spaceIndex() + 1))
  return (
    <box flexDirection="row">
      <text>{name()}</text>
      <Show when={args() !== ""}>
        <text fg={themeTokens().muted}>{` ${args()}`}</text>
      </Show>
    </box>
  )
}

function messageMarginTop(message: Message): number {
  return message.kind === "user" || message.kind === "info" || message.isCall ? 1 : 0
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

/** The provider's API key from its conventional env var, when one is set. */
function presetKeyFromEnv(providerId: string): string | undefined {
  const name = presetEnvKey(providerId)
  return name ? process.env[name] : undefined
}

const PROVIDERS: ProviderChoice[] = [
  { id: "sarvam", needsKey: true, example: "sarvam-105b" },
  { id: "openai", needsKey: true, example: "gpt-5-mini" },
  { id: "openrouter", needsKey: true, example: "qwen/qwen3-coder" },
  { id: "anthropic", needsKey: true, example: "claude-sonnet-4-6" },
  { id: "google", needsKey: true, example: "gemini-2.5-flash" },
  { id: "nvidia", needsKey: true, example: "meta/llama-3.3-70b-instruct" },
  { id: "litellm", needsKey: true, example: "gpt-4o (any model_name on your proxy)" },
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

const LOOP_TUI_RULES: PermissionRules = {
  "*": "allow",
  edit: { "**/.env*": "deny", ".env*": "deny" },
}

const GIT_STATUS_TIMEOUT_MS = 15_000

const LOOP_PLANNER_PROMPT = `You are the planning stage of an autonomous coding loop. Break the specification into 2-10 SMALL, independently verifiable tasks. Each task must be completable in one focused session and checkable by the project's test/build gates.

Reply with ONLY a JSON array, no prose:
[{"title":"short imperative title","spec":"exact, self-contained instructions","blockedBy":[0]}]
"blockedBy" lists 0-based indexes of tasks that must finish first. Prefer independent tasks; add dependencies only when strictly required. Implement nothing yourself.`

function loopPaths(cwd: string): { queue: string; handoff: string; sessions: string } {
  return {
    queue: join(cwd, ".butterfly", "queue.db"),
    handoff: join(cwd, ".butterfly", "handoff.json"),
    sessions: join(cwd, ".butterfly", "sessions"),
  }
}

export function App(props: { cwd: string; config: ButterflyConfig; home?: string }) {
  const home = props.home ?? homedir()
  const displayPath = (path: string): string =>
    middleEllipsize(path.startsWith(home) ? `~${path.slice(home.length)}` : path, 70)
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

  const customThemes = loadCustomThemes(home)
  setThemeTokens(resolveTheme(config().theme ?? "dark", customThemes))
  const applyAutoThemeMode = (mode: "dark" | "light") => {
    if (config().theme) return // pinned — auto-detect never overrides it
    setThemeTokens(resolveTheme(mode === "light" ? "light" : "dark", customThemes))
  }
  if (!config().theme && renderer.themeMode) applyAutoThemeMode(renderer.themeMode)
  onMount(() => {
    const onThemeMode = (mode: "dark" | "light") => applyAutoThemeMode(mode)
    renderer.on("theme_mode", onThemeMode)
    onCleanup(() => renderer.off("theme_mode", onThemeMode))
  })

  const [messages, setMessages] = createSignal<Message[]>([])
  const [thinkingExpanded, setThinkingExpanded] = createSignal(false)
  const latestTodoIndex = createMemo(() => {
    const list = messages()
    let last = -1
    for (let i = 0; i < list.length; i++) {
      if (list[i]?.todos !== undefined) last = i
    }
    return last
  })
  const [draft, setDraft] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [pendingAsk, setPendingAsk] = createSignal<PendingAsk | null>(null)
  const [status, setStatus] = createSignal("")
  const [lastTurnMarker, setLastTurnMarker] = createSignal("")
  const resetTurnStatus = () => {
    setStatus("")
    setLastTurnMarker("")
  }

  let osc52UnsupportedNotified = false
  useSelectionHandler((selection) => {
    const text = selection.getSelectedText()
    if (!text) return
    if (!renderer.isOsc52Supported()) {
      if (!osc52UnsupportedNotified) {
        osc52UnsupportedNotified = true
        push({ kind: "info", text: COPY_UNSUPPORTED_TEXT })
      }
      return
    }
    const { text: payload, truncated } = capOsc52Text(text)
    let copied = false
    try {
      copied = renderer.copyToClipboardOSC52(payload)
    } catch {
      return
    }
    if (!copied) return
    setStatus(copyStatusText(truncated))
  })

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
    note?: string
    items: { label: string; value: string }[]
    index: number
    filter: string
    onPick: (value: string) => void
  } | null>(null)
  const [providerKeyStep, setProviderKeyStep] = createSignal<{
    provider: string
    hasExisting: boolean
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
  const [loopCard, setLoopCard] = createSignal<LoopCardState | null>(null)
  let loopAbort: AbortController | undefined

  const cmdList = (): SlashCommand[] =>
    !setup() && !picker() && !busy() && !providerKeyStep() ? commandMatches(draft()) : []

  const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  const [spin, setSpin] = createSignal(0)
  const spinTimer = setInterval(() => {
    if (busy()) setSpin((s) => (s + 1) % SPINNER.length)
  }, 80)
  onCleanup(() => clearInterval(spinTimer))

  const [turnStartedAt, setTurnStartedAt] = createSignal<number | undefined>(undefined)
  const [elapsedTick, setElapsedTick] = createSignal(0)
  const elapsedTimer = setInterval(() => {
    if (busy()) setElapsedTick((t) => t + 1)
  }, 1000)
  onCleanup(() => clearInterval(elapsedTimer))
  const elapsedText = (): string => {
    elapsedTick() // subscribe: re-render once a second while busy
    const start = turnStartedAt()
    return start === undefined ? "" : formatDuration(Date.now() - start)
  }

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
  /** USD/1M pricing for any provider/model ref, from the catalog. */
  const costForRef = (ref: string | undefined) => {
    if (!ref) return undefined
    try {
      const parsed = parseModelRef(ref)
      return catalog.lookup(parsed.providerId, parsed.modelId)?.cost
    } catch {
      return undefined
    }
  }
  const modelCost = () => costForRef(modelRef())
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
  const bgTasks = new BgTaskRegistry({
    cwd: props.cwd,
    logDir: join(props.cwd, ".butterfly", "bg"),
    journal: session.journal,
    onEnd: (record) => {
      push({
        kind: "info",
        text: `background task ${record.id} ${record.status}${record.exitCode !== undefined ? ` (exit ${record.exitCode})` : ""} — ${record.command}`,
      })
    },
  })
  state[BG_TASKS_STATE_KEY] = bgTasks
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

  let codeGraph: CodeGraph | undefined
  try {
    codeGraph = CodeGraph.open(props.cwd)
  } catch {
  }
  const graphDb = (): GraphDb | undefined => (codeGraph?.ready ? codeGraph.db : undefined)
  const graphRefresh = () => codeGraph?.fresh() ?? Promise.resolve()
  let graph: GraphDb | undefined
  registry.register(createExploreTool({ db: graphDb, cwd: props.cwd, refresh: graphRefresh }))
  void (async () => {
    try {
      await codeGraph?.sync()
      graph = graphDb()
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
    sub.register(createExploreTool({ db: graphDb, cwd: props.cwd, refresh: graphRefresh }))
    sub.register(createWebTool({ config: () => config().web }))
  }
  const taskToolOpts: TaskToolOptions = {
    provider: () => freshProvider(),
    model: () => modelRef() ?? "",
    subagentModel: () => config().subagent_model ?? config().small_model,
    costFor: (m) => costForRef(m),
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
  const buildLoopRegistry = (): ToolRegistry => {
    const sub = new ToolRegistry()
    sub.register(bashTool)
    sub.register(readTool)
    sub.register(editTool)
    sub.register(globTool)
    sub.register(grepTool)
    sub.register(todoTool)
    sub.register(createExploreTool({ db: graphDb, cwd: props.cwd, refresh: graphRefresh }))
    sub.register(createMemoryTool({ paths, episodic: () => episodic }))
    sub.register(createSkillTool({ dirs: skillDirs }))
    sub.register(createWebTool({ config: () => config().web }))
    return sub
  }
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
    bgTasks.reap()
    try {
      renderer.destroy()
    } catch {
      clearTerminalProgress()
      process.exit(0)
    }
  }

  const push = (message: Message) => {
    setMessages([...messages(), message])
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
    const combined = last?.kind === "assistant" ? last.text + text : text
    const startedAt = last?.kind === "assistant" ? (last.thinkStartedAt ?? Date.now()) : Date.now()
    const alreadyClosedAt = last?.kind === "assistant" ? last.thinkClosedAt : undefined
    const split = splitThink(combined)
    const closedAt =
      alreadyClosedAt ?? (split.thinking !== "" && !split.open ? Date.now() : undefined)
    const updated: Message = {
      kind: "assistant",
      text: combined,
      thinkStartedAt: startedAt,
      ...(closedAt !== undefined ? { thinkClosedAt: closedAt } : {}),
    }
    if (last?.kind === "assistant") all[all.length - 1] = updated
    else all.push(updated)
    setMessages(all)
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
    setPagerNotice("rendering…")
    setPagerOpen(true)
    setTimeout(() => {
      setPagerNotice((current) => (current === "rendering…" ? "" : current))
    }, 500)
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
    const dir = join(tmpdir(), "butterfly", "pager")
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${id}.md`)
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

  let providerErrorRendered = false

  let stepAnchor = 0

  const appendReasoning = (text: string) => {
    const all = [...messages()]
    const last = all.at(-1)
    if (last?.kind === "thinking" && last.thinkClosedAt === undefined) {
      all[all.length - 1] = { ...last, text: last.text + text }
    } else {
      all.push({ kind: "thinking", text, thinkStartedAt: Date.now() })
    }
    setMessages(all)
  }

  const finalizeOpenThinking = () => {
    const all = [...messages()]
    let changed = false
    for (let i = all.length - 1; i >= 0; i--) {
      const message = all[i]
      if (message === undefined) continue
      if (message.kind === "user") break // turn boundary — nothing older is ours
      if (message.thinkClosedAt !== undefined) continue
      const isThinkingBlock =
        message.kind === "thinking" ||
        (message.kind === "assistant" && splitThink(message.text).thinking !== "")
      if (!isThinkingBlock) continue
      all[i] = { ...message, thinkClosedAt: Date.now() }
      changed = true
    }
    if (changed) setMessages(all)
  }

  const onEvent = (event: RunnerEvent) => {
    switch (event.type) {
      case "reasoning-delta":
        appendReasoning(event.text)
        break
      case "text-delta":
        finalizeOpenThinking()
        appendAssistant(event.text)
        break
      case "tool-call":
        finalizeOpenThinking()
        push(toolCallMessage(event.name, event.input))
        break
      case "tool-result":
        push(toolResultMessage(event.output, event.isError, event.meta))
        stepAnchor = messages().length
        break
      case "step-retracted": {
        const settled = messages().slice(0, stepAnchor)
        if (settled.length !== messages().length) setMessages(settled)
        break
      }
      case "finish":
        finalizeOpenThinking()
        // Live context gauge: the last step's input+output IS the window size.
        setCtxUsed(event.usage.input + event.usage.output)
        break
      case "error": {
        finalizeOpenThinking()
        providerErrorRendered = true
        push(
          event.info
            ? { kind: "error", text: errorCardHeadline(event.info), errorInfo: event.info }
            : { kind: "error", text: `Error: ${event.message}` },
        )
        break
      }
      case "notice":
        push({ kind: "info", text: event.text })
        stepAnchor = messages().length
        break
      default:
        break
    }
  }

  const freshProvider = () => new AiSdkProvider(createModelResolver(config()))

  const modelListItems = async (
    providerId: string,
    apiKey?: string,
  ): Promise<{ models: { id: string; context?: number; name?: string }[]; live: boolean }> => {
    const providerConfig = config().providers?.[providerId]
    const live = await fetchProviderModels(providerId, {
      apiKey: apiKey ?? providerConfig?.apiKey ?? presetKeyFromEnv(providerId),
      baseURL: providerConfig?.baseURL ?? presetBaseURL(providerId),
    })
    if (live.length > 0) return { models: live, live: true }
    return { models: catalog.listModels(providerId), live: false }
  }

  const modelLabel = (m: { id: string; context?: number; name?: string }): string =>
    `${m.id}${m.context ? `  (${Math.round(m.context / 1000)}k ctx)` : ""}${m.name && m.name !== m.id ? `  — ${m.name}` : ""}`

  const noModelsNote = (providerId: string): string =>
    providerId === "ollama"
      ? "no local ollama models found (is the server running? `ollama pull <model>` to add one)"
      : `no model list available for "${providerId}" (offline or bad key?) — you can still type any model id`

  const catalogFallbackNote = (providerId: string): string =>
    PROVIDERS.find((p) => p.id === providerId)?.needsKey === true
      ? "live list unavailable — showing catalog; the key was NOT validated"
      : `live list unavailable — showing catalog; ${providerId} was not reachable`

  const modelListText = async (providerId: string, apiKey?: string): Promise<string> => {
    const { models } = await modelListItems(providerId, apiKey)
    if (models.length === 0) return noModelsNote(providerId)
    const shown = models.slice(0, 25)
    const more = models.length - shown.length
    return `${providerId} models:\n${shown.map((m) => `  ${modelLabel(m)}`).join("\n")}${more > 0 ? `\n  … ${more} more — type any id` : ""}`
  }

  const applyProviderSelection = (
    provider: string,
    modelId: string,
    newKey: string | undefined,
    fromCatalog = false,
  ): void => {
    try {
      const path = saveGlobalConfig(
        {
          model: `${provider}/${modelId}`,
          ...(newKey ? { providers: { [provider]: { apiKey: newKey } } } : {}),
        },
        { home },
      )
      setConfig(loadConfig({ cwd: props.cwd, home }))
      refreshCtxLimit()
      setCtxUsed(0)
      push({ kind: "info", text: `Saved to ${path}` })
      push({ kind: "info", text: `Ready on ${provider}/${modelId}` })
      if (fromCatalog) {
        push({ kind: "info", text: `note: ${catalogFallbackNote(provider)}` })
      }
      if (!SELF_NAMED_PROVIDERS.has(provider) && !catalog.lookup(provider, modelId)) {
        push({
          kind: "info",
          text: `note: "${provider}/${modelId}" is not in the models.dev catalog — double-check the id if requests fail (/provider to change it).`,
        })
      }
    } catch (error) {
      push({
        kind: "error",
        text: `Could not save config: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  const openProviderModelPicker = async (
    provider: string,
    newKey: string | undefined,
  ): Promise<void> => {
    const { models, live } = await modelListItems(provider, newKey)
    if (models.length === 0) {
      push({ kind: "info", text: noModelsNote(provider) })
      return
    }
    setPicker({
      title: `${provider} models — type to filter · ↑↓ · Enter switch · Esc`,
      ...(live ? {} : { note: catalogFallbackNote(provider) }),
      items: models.map((m) => ({ label: modelLabel(m), value: m.id })),
      index: 0,
      filter: "",
      onPick: (value) => applyProviderSelection(provider, value, newKey, !live),
    })
  }

  const handleProviderKeySubmit = (
    step: { provider: string; hasExisting: boolean },
    value: string,
  ): void => {
    const typed = value.trim()
    setProviderKeyStep(null)
    void openProviderModelPicker(step.provider, typed === "" ? undefined : typed)
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
      resetTurnStatus()
    }
    push({ kind: "info", text: `rewound (${mode}) to ${checkpointLabel(checkpoint.event)}` })
  }

  const actions: CommandActions = {
    info: (text, structured) =>
      push({ kind: "info", text, ...(structured ? { structured: true } : {}) }),
    error: (text) => push({ kind: "error", text }),
    openSetup: () => setSetup({ stage: "provider" }),
    quit,
    newSession: () => {
      session.journal = SessionJournal.create(join(props.cwd, ".butterfly", "sessions"))
      setMessages([])
      resetTurnStatus()
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
        `journal    ${displayPath(session.journal.path)}`,
        `last turn  ${lastTurnMarker() || "—"}`,
      ].join("\n")
    },
    showModels: async () => {
      const ref = modelRef()
      const providerId = ref ? parseModelRef(ref).providerId : "openrouter"
      const { models, live } = await modelListItems(providerId)
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
        ...(live ? {} : { note: catalogFallbackNote(providerId) }),
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
    memoryText: () => renderMemoryView(paths),
    memoryAdd: (scope, text) => {
      const result = applyMemoryOp(paths, { op: "add", scope, text })
      if (result.ok)
        push({
          kind: "info",
          text: `remembered (${scope}): ${text} — in the prompt from next session`,
        })
      else push({ kind: "error", text: result.message })
    },
    memoryForget: (n) => {
      const removed = forgetMemoryLine(paths, n)
      if (removed) push({ kind: "info", text: `forgot ${removed.scope} #${n}: ${removed.text}` })
      else push({ kind: "error", text: `no memory line #${n} — /memory shows the numbers` })
    },
    memorySearch: (query) => {
      const hits = episodic.search(query, 6)
      if (hits.length === 0) return `no past-session matches for "${query}"`
      return hits
        .map(
          (hit) =>
            `[${hit.time.slice(0, 10)} ${hit.type} ${hit.sessionId.slice(0, 8)}] ${hit.text.replace(/\s+/g, " ").slice(0, 200)}`,
        )
        .join("\n")
    },
    permissionsText: () => JSON.stringify(config().permissions ?? TUI_DEFAULT_RULES, null, 2),
    skillsText: () => renderSkillsView(skillDirs),
    pickSkill: () => {
      const skills = listSkills(skillDirs)
      if (skills.length === 0) {
        push({ kind: "info", text: renderSkillsView(skillDirs) })
        return
      }
      setPicker({
        title: "skills — type to filter · ↑↓ · Enter show · Esc",
        items: skills.map((skill) => ({
          label: `${skill.name}  [${skillStatus(skill)}]  ${skill.description}`,
          value: skill.name,
        })),
        index: 0,
        filter: "",
        onPick: (name) => push({ kind: "info", text: actions.showSkill(name) }),
      })
    },
    showSkill: (name) => {
      const meta = listSkills(skillDirs).find((skill) => skill.name === name)
      const body = readSkill(skillDirs, name)
      if (!meta || body === null) return `no skill named "${name}"`
      return `${meta.name} — ${meta.description}\n${skillStatus(meta)} · ${meta.path}\n\n${body}\n\n/skills promote ${meta.name} · /skills delete ${meta.name}`
    },
    promoteSkill: (name) => {
      const meta = promoteSkill(skillDirs, name)
      if (meta)
        push({
          kind: "info",
          text: `promoted ${name} — in every session's skill index from next session`,
        })
      else push({ kind: "error", text: `no skill named "${name}"` })
    },
    deleteSkill: (name) => {
      const removed = deleteSkill(skillDirs, name)
      if (removed) push({ kind: "info", text: `deleted skill ${name} (${removed})` })
      else push({ kind: "error", text: `no skill named "${name}"` })
    },
    listSessionsText: () => {
      lastListing = listSessions(join(props.cwd, ".butterfly", "sessions")).filter(
        (s) => s.title !== "(empty session)" || s.path === session.journal.path,
      )
      // Journals are written lazily (first event), so a fresh current
      // session has no file yet — it still gets its "(current)" row.
      if (!lastListing.some((s) => s.path === session.journal.path)) {
        lastListing.unshift({
          id: session.journal.header.sessionId,
          path: session.journal.path,
          modified: Date.now(),
          title: "(empty session)",
          turns: 0,
        })
      }
      const lines = lastListing.map(
        (s, i) =>
          `  ${i + 1}  ${new Date(s.modified).toISOString().slice(0, 16).replace("T", " ")}  ${s.title}${s.path === session.journal.path ? "  (current)" : ""}`,
      )
      return `sessions (newest first):\n${lines.join("\n")}\nresume with /sessions <number>, or /resume for a picker`
    },
    graphText: () => {
      if (!codeGraph) return "code graph unavailable (could not open .butterfly/graph.db)"
      if (!codeGraph.ready) {
        return codeGraph.lastError
          ? `code graph sync failed: ${codeGraph.lastError}`
          : "code graph: first sync still running…"
      }
      const stats = codeGraph.db.stats()
      const last = codeGraph.lastSyncTime ?? stats.lastSync
      const age = last ? Math.round((Date.now() - last) / 1000) : undefined
      const overview = moduleOverview(codeGraph.db, 300)
      return [
        `files      ${stats.files}`,
        `symbols    ${stats.symbols}`,
        `refs       ${stats.refs}`,
        `synced     ${age === undefined ? "never" : age < 2 ? "just now" : `${age}s ago`}`,
        `index      ${join(".butterfly", "graph.db")}`,
        `map        ${join(".butterfly", "project-map.md")}  (modules, Mermaid dependency graph, hubs)`,
        ...(overview ? ["", overview] : []),
        "",
        "the agent queries this via explore op=map|outline|symbol|deps · /graph rebuild re-indexes",
      ].join("\n")
    },
    rebuildGraph: async () => {
      if (!codeGraph) {
        push({ kind: "error", text: "code graph unavailable" })
        return
      }
      const started = Date.now()
      try {
        const result = await codeGraph.sync({ forceMap: true })
        graph = graphDb()
        push({
          kind: "info",
          text: `graph synced in ${Date.now() - started}ms — ${result.scanned} re-indexed, ${result.skipped} unchanged, ${result.removed} removed; map written to .butterfly/project-map.md`,
        })
      } catch (error) {
        push({ kind: "error", text: `graph sync failed: ${String(error)}` })
      }
    },
    worktreesText: async () => {
      const all = listWorktrees(props.cwd)
      if (all.length === 0) {
        return 'no agent worktrees pending — the model creates them with task isolation:"worktree" (one per parallel worker)'
      }
      const rows = await Promise.all(
        all.map(async (w) => {
          const status = w.meta?.baseSha ? await worktreeStatus(w.path, w.meta.baseSha) : undefined
          const changes = status
            ? status.undetermined
              ? "status unknown"
              : `${status.changedFiles} changed, ${status.commitsAhead} commits`
            : "base unknown"
          return `  ${w.id.slice(0, 8)}  ${changes.padEnd(24)}  ${w.meta?.task?.slice(0, 60) ?? ""}`
        }),
      )
      return [
        `agent worktrees (${all.length}/${MAX_CONCURRENT_WORKTREES} slots):`,
        ...rows,
        "",
        "/worktrees merge <id> applies one to your working tree (unstaged) · /worktrees discard <id>",
      ].join("\n")
    },
    mergeWorktree: async (id) => {
      const merged = await mergeWorktree(props.cwd, id)
      if (!merged.ok) push({ kind: "error", text: merged.error })
      else
        push({
          kind: "info",
          text:
            merged.files.length === 0
              ? "worktree had no changes — removed"
              : `merged ${merged.files.length} file(s) into the working tree (unstaged): ${merged.files.join(", ")}`,
        })
    },
    discardWorktree: async (id) => {
      const removed = await discardWorktree(props.cwd, id)
      if (removed.ok) push({ kind: "info", text: `discarded worktree ${id}` })
      else push({ kind: "error", text: removed.error })
    },
    pickSession: () => {
      lastListing = listSessions(join(props.cwd, ".butterfly", "sessions")).filter(
        (s) => s.title !== "(empty session)" || s.path === session.journal.path,
      )
      const past = lastListing.filter((s) => s.path !== session.journal.path)
      if (past.length === 0) {
        push({ kind: "info", text: "no past sessions to resume yet" })
        return
      }
      setPicker({
        title: "resume a session — type to filter · ↑↓ · Enter resume · Esc",
        items: past.map((s) => ({
          label: `${new Date(s.modified).toISOString().slice(0, 16).replace("T", " ")}  ${s.title}`,
          value: s.id,
        })),
        index: 0,
        filter: "",
        onPick: (id) => actions.resumeSession(id),
      })
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
        resetTurnStatus()
        setCtxUsed(0)
        firstTurn = false
        push({ kind: "info", text: `resumed session ${target.id.slice(0, 8)} — ${target.title}` })
      } catch (error) {
        push({ kind: "error", text: `resume failed: ${String(error)}` })
      }
    },
    pickEffort: () => {
      const levels = ["provider default", "none", "minimal", "low", "medium", "high", "xhigh"]
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
      return renderDoctorReport(
        {
          ...report,
          journal: {
            ...report.journal,
            path: report.journal.path && displayPath(report.journal.path),
          },
        },
        { bar },
      )
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
    tasksText: () => {
      const tasks = bgTasks.list()
      if (tasks.length === 0) return "no background tasks this session."
      const lines = tasks.map((t) => {
        const cmd = t.command.length > 60 ? `${t.command.slice(0, 60)}…` : t.command
        const exit = t.exitCode !== undefined ? ` exit ${t.exitCode}` : ""
        return `  ${t.id}  ${t.status.padEnd(7)}${exit.padEnd(9)}  pid ${t.pid}  ${cmd}`
      })
      return ["background tasks:", ...lines, "", "/tasks show <id> · /tasks kill <id>"].join("\n")
    },
    killTask: (id) => {
      const ok = bgTasks.kill(id)
      push({
        kind: "info",
        text: ok ? `killed background task ${id}` : `no running background task "${id}"`,
      })
    },
    showTask: (id) => {
      const record = bgTasks.get(id)
      if (!record) return `no background task "${id}"`
      const exit = record.exitCode !== undefined ? `  exit ${record.exitCode}` : ""
      const tail = (bgTasks.tail(id, 2_000) ?? "").trim()
      return [
        `${record.id}  ${record.status}  pid ${record.pid}${exit}`,
        record.command,
        record.logPath,
        "",
        tail === "" ? "(no output yet)" : tail,
      ].join("\n")
    },
    loopPlan: async (goal) => {
      const ref = modelRef()
      if (!ref) {
        push({ kind: "error", text: "no model configured — run /setup first" })
        return
      }
      push({ kind: "info", text: "planning…" })
      try {
        const planRegistry = new ToolRegistry()
        const journal = SessionJournal.create(join(props.cwd, ".butterfly", "sessions"))
        const outcome = await runUserTurn(
          {
            provider: freshProvider(),
            registry: planRegistry,
            journal,
            rules: { "*": "deny" },
            model: ref,
            system: LOOP_PLANNER_PROMPT,
            cwd: props.cwd,
            maxSteps: 1,
            ...(config().retries !== undefined ? { retries: config().retries } : {}),
          },
          goal,
        )
        const start = outcome.text.indexOf("[")
        const end = outcome.text.lastIndexOf("]")
        if (start < 0 || end <= start) {
          push({
            kind: "error",
            text: `planner did not return JSON:\n${outcome.text.slice(0, 400)}`,
          })
          return
        }
        let tasks: { title: string; spec: string; blockedBy?: number[] }[]
        try {
          tasks = JSON.parse(outcome.text.slice(start, end + 1))
        } catch (error) {
          push({ kind: "error", text: `planner JSON parse failed: ${String(error)}` })
          return
        }
        const queue = WorkQueue.open(loopPaths(props.cwd).queue)
        const ids: string[] = []
        for (const task of tasks) {
          const blockedBy = (task.blockedBy ?? [])
            .map((index) => ids[index])
            .filter((id): id is string => id !== undefined)
          ids.push(queue.addTask({ title: task.title, spec: task.spec, blockedBy }))
        }
        const counts = queue.counts()
        queue.closeDb()
        push({
          kind: "info",
          text: [
            `planned ${ids.length} task(s) — queue: ${JSON.stringify(counts)}`,
            ...tasks.map((t, i) => {
              const after = t.blockedBy?.length
                ? `  (after ${t.blockedBy.map((b) => ids[b]).join(", ")})`
                : ""
              return `  ${ids[i]}  ${t.title}${after}`
            }),
            "/loop run to start the supervisor",
          ].join("\n"),
        })
      } catch (error) {
        push({
          kind: "error",
          text: `planning failed: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    },
    loopRun: async (allowDirty: boolean) => {
      if (planMode()) {
        push({
          kind: "error",
          text: "/loop run is denied in plan mode — it edits files and commits. /plan to exit plan mode, or /loop plan to stage tasks read-only.",
        })
        return
      }
      const ref = modelRef()
      if (!ref) {
        push({ kind: "error", text: "no model configured — run /setup first" })
        return
      }
      const gates: Gate[] = config().gates ?? []
      if (gates.length === 0) {
        push({
          kind: "error",
          text: 'no gates configured — refusing to loop blind. Add e.g. "gates": [{"name":"test","command":"bun test"}] to butterfly.jsonc',
        })
        return
      }
      setBusy(true)
      setTurnStartedAt(Date.now())
      loopAbort = new AbortController()
      const gitStatus = await runCommand("git status --porcelain", {
        cwd: props.cwd,
        timeoutMs: GIT_STATUS_TIMEOUT_MS,
      })
      const dirty =
        gitStatus.exitCode === 0 && !gitStatus.timedOut ? dirtyLoopLines(gitStatus.stdout) : []
      const abandonBeforeStart = (): void => {
        setBusy(false)
        loopAbort = undefined
        drainQueue()
      }
      if (dirty.length > 0 && !allowDirty) {
        push({ kind: "error", text: dirtyTreeRefusal(dirty) })
        abandonBeforeStart()
        return
      }
      if (loopAbort.signal.aborted) {
        abandonBeforeStart()
        return
      }
      if (dirty.length > 0) push({ kind: "info", text: dirtyTreeOverride(dirty) })
      setLoopCard(INITIAL_LOOP_CARD)
      const attentionState = () => ({
        focus: focused() ? ("focused" as const) : ("blurred" as const),
        cwd: props.cwd,
      })
      const attentionConfig = () => ({ notifications: config().notifications ?? true })
      applyAttention(decideAttention({ kind: "turn.start" }, attentionState(), attentionConfig()))
      let loopDetail: string | undefined
      let queue: WorkQueue | undefined
      let loopCredited = 0
      const creditLoopSpend = (usage: Usage) => {
        const credit = loopSpendCredit(usage, modelCost(), loopCredited)
        loopCredited = credit.credited
        if (credit.delta > 0) setSessionCost((c) => c + credit.delta)
      }
      const cap = config().maxSpendUSD
      if (cap !== undefined) push({ kind: "info", text: spendCapNotice(cap) })
      const rules = config().permissions ?? LOOP_TUI_RULES
      const asks = askBearingRules(rules)
      if (asks.length > 0) push({ kind: "info", text: askRulesWarning(asks) })
      try {
        const queuePaths = loopPaths(props.cwd)
        queue = WorkQueue.open(queuePaths.queue)
        const outcome = await runLoop({
          queue,
          provider: freshProvider(),
          makeRegistry: buildLoopRegistry,
          rules,
          model: ref,
          system: frozenSystem(ref),
          cwd: props.cwd,
          gates,
          sessionsDir: queuePaths.sessions,
          handoffPath: queuePaths.handoff,
          signal: loopAbort.signal,
          ...(config().retries !== undefined ? { retries: config().retries } : {}),
          ...(config().small_model ? { smallModel: config().small_model } : {}),
          onEvent: (event: LoopEvent) => {
            if ("progress" in event) creditLoopSpend(event.progress.usage)
            setLoopCard((prev) => applyLoopEvent(prev ?? INITIAL_LOOP_CARD, event))
          },
        })
        creditLoopSpend(outcome.usage)
        loopDetail = `${outcome.stopReason}: ${outcome.closed} closed, ${outcome.blocked} blocked`
        push({ kind: "info", text: loopSummaryText(outcome) })
      } catch (error) {
        loopDetail = error instanceof Error ? error.message : String(error)
        push({ kind: "error", text: `loop failed: ${loopDetail}` })
      } finally {
        queue?.closeDb()
        applyAttention(
          decideAttention(
            { kind: "turn.end", detail: loopDetail },
            attentionState(),
            attentionConfig(),
          ),
        )
        setLoopCard(null)
        setBusy(false)
        loopAbort = undefined
        drainQueue()
      }
    },
    loopStatusText: () => {
      const queuePaths = loopPaths(props.cwd)
      const queue = WorkQueue.open(queuePaths.queue)
      const counts = queue.counts()
      const ready = queue.ready()
      queue.closeDb()
      const lines = [`loop queue: ${JSON.stringify(counts)}`]
      for (const task of ready) lines.push(`  ready: ${task.id}  ${task.title}`)
      try {
        lines.push(`handoff: ${readFileSync(queuePaths.handoff, "utf8").trim()}`)
      } catch {
      }
      return lines.join("\n")
    },
    pickTheme: () => {
      const names = listThemeNames(home)
      const current = config().theme ?? "dark"
      setPicker({
        title: "theme — ↑↓ · Enter switch · Esc",
        items: names.map((name) => ({
          label: name === current ? `${name}  (current)` : name,
          value: name,
        })),
        index: Math.max(0, names.indexOf(current)),
        filter: "",
        onPick: (value) => actions.setTheme(value),
      })
    },
    setTheme: (name) => {
      const trimmed = name.trim()
      const custom = loadCustomThemes(home)
      const known = new Set([...Object.keys(BUILTIN_THEMES), ...Object.keys(custom)])
      if (!known.has(trimmed)) {
        push({
          kind: "error",
          text: `unknown theme "${trimmed}" — try ${listThemeNames(home).join(", ")}`,
        })
        return
      }
      setThemeTokens(resolveTheme(trimmed, custom))
      try {
        saveGlobalConfig({ theme: trimmed }, { home })
        setConfig(loadConfig({ cwd: props.cwd, home }))
        push({ kind: "info", text: `theme set to ${trimmed}` })
      } catch (error) {
        push({
          kind: "error",
          text: `theme applied but failed to persist: ${String(error instanceof Error ? error.message : error)}`,
        })
      }
    },
    pickProvider: () => {
      const ref = modelRef()
      let currentProvider: string | undefined
      try {
        currentProvider = ref ? parseModelRef(ref).providerId : undefined
      } catch {
        currentProvider = undefined
      }
      setPicker({
        title: "provider — ↑↓ · Enter select · Esc",
        items: PROVIDERS.map((p) => {
          const marks = [
            p.id === currentProvider ? "(current)" : "",
            config().providers?.[p.id]?.apiKey ? "[key]" : "",
          ]
            .filter(Boolean)
            .join("  ")
          return { label: marks ? `${p.id}  ${marks}` : p.id, value: p.id }
        }),
        index: Math.max(
          0,
          PROVIDERS.findIndex((p) => p.id === currentProvider),
        ),
        filter: "",
        onPick: (value) => actions.selectProvider(value),
      })
    },
    selectProvider: (nameOrPrefix) => {
      const trimmed = nameOrPrefix.trim().toLowerCase()
      const exact = PROVIDERS.find((p) => p.id === trimmed)
      const prefixMatches = PROVIDERS.filter((p) => p.id.startsWith(trimmed))
      const choice = exact ?? (prefixMatches.length === 1 ? prefixMatches[0] : undefined)
      if (!choice) {
        push({
          kind: "error",
          text: `unknown provider "${nameOrPrefix}" — try ${PROVIDERS.map((p) => p.id).join(", ")}`,
        })
        return
      }
      if (choice.needsKey) {
        setProviderKeyStep({
          provider: choice.id,
          hasExisting: Boolean(config().providers?.[choice.id]?.apiKey),
        })
        return
      }
      void openProviderModelPicker(choice.id, undefined)
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
      resetTurnStatus()
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
      setTurnStartedAt(Date.now())
      try {
        const diffOpts = parseReviewArg(arg)
        const result = await runReview(props.cwd, taskToolOpts, diffOpts)
        if (result.rejected) {
          push({ kind: "error", text: result.rejected })
          return
        }
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
    handoff: async () => {
      const ref = modelRef()
      if (!ref) {
        push({ kind: "error", text: "no model configured" })
        return
      }
      push({ kind: "info", text: "writing handoff…" })
      setBusy(true)
      setTurnStartedAt(Date.now())
      try {
        const result = await runHandoffTurn({
          provider: freshProvider(),
          journal: session.journal,
          model: ref,
          system: frozenSystem(ref),
          cwd: props.cwd,
          ...(modelCost() ? { cost: modelCost() } : {}),
          ...(config().maxSpendUSD !== undefined ? { maxSpendUSD: config().maxSpendUSD } : {}),
          onEvent: (event) => {
            if (event.type === "notice") push({ kind: "info", text: event.text })
          },
        })
        setSessionCost((c) => c + result.costUSD)
        if (result.doc === "") {
          push({ kind: "error", text: "handoff failed — the model returned nothing" })
          return
        }
        const saved = saveHandoff(props.cwd, result.doc, result.truncated, session.journal)
        push({ kind: "assistant", text: result.doc })
        push({
          kind: "info",
          text: `handoff saved — ${saved.path} (+ archived copy)${result.truncated ? " — truncated to fit the cap" : ""}\nthe next session preloads it: /new, a fresh \`butterfly\`, or \`butterfly run --resume-handoff\` (this session won't reload it)`,
        })
      } catch (error) {
        push({
          kind: "error",
          text: `handoff failed: ${error instanceof Error ? error.message : String(error)}`,
        })
      } finally {
        setBusy(false)
        drainQueue()
      }
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
      if (!SELF_NAMED_PROVIDERS.has(stage.provider)) {
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
    const keyStep = providerKeyStep()
    if (rawTask === "" && keyStep) {
      handleProviderKeySubmit(keyStep, "")
      return
    }
    if (rawTask === "" || pendingAsk()) return
    const task = expandComposerText(rawTask, pasteChips())
    if (source === "composer") {
      const orphans = unreferencedChips(rawTask, pasteChips())
      if (orphans.length > 0) {
        const which = orphans.map((n) => `#${n}`).join(", ")
        push({
          kind: "info",
          text: `warn: paste chip${orphans.length === 1 ? "" : "s"} ${which} ${orphans.length === 1 ? "is" : "are"} no longer in the message — that text was NOT sent`,
        })
      }
    }
    if (busy()) {
      setQueued([...queued(), task])
      setDraft("")
      setPasteChips(new Map())
      push({ kind: "info", text: `(queued) (${queued().length}): ${task.slice(0, 80)}` })
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
    if (keyStep) {
      handleProviderKeySubmit(keyStep, task)
      return
    }

    setHistory([...history().slice(-99), task])
    historyPos = -1

    let modelTask = task
    const typedToken = task.startsWith("/")
      ? (task.slice(1).split(/\s+/)[0]?.toLowerCase() ?? "")
      : ""
    const exactCustom = customCommands.some((c) => c.name === typedToken)
    const visibleMatches = task.startsWith("/") && !exactCustom ? commandMatches(task) : []
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
    if (firstTurn) {
      const preload = preloadHandoff(props.cwd, taskText, {
        journalPath: session.journal.path,
      })
      taskText = preload.taskText
      if (preload.notice) push({ kind: "info", text: preload.notice })
      if (graph) {
        const mentionedWords = task.split(/[^A-Za-z0-9_]+/).filter((word) => word.length >= 3)
        const skeleton = buildSkeleton(graph, {
          mentionedIdents: mentionedWords,
          chatFiles: mentions.map((m) => m.path),
        })
        const overview = moduleOverview(graph)
        const block = [overview, skeleton].filter((part) => part !== "").join("\n\n")
        if (block !== "") {
          taskText = `[repository map — modules + ranked symbols; explore op=map|outline|symbol|deps for more]\n${block}\n\n${taskText}`
        }
      }
    } else if (graph) {
      const focused = focusedSkeleton(graph, task)
      if (focused !== "")
        taskText = `${taskText}\n\n[code graph — where the names above live]\n${focused}`
    }
    firstTurn = false
    setBusy(true)
    setTurnStartedAt(Date.now())
    abort = new AbortController()
    const limit = ctxLimit()
    const attentionState = () => ({
      focus: focused() ? ("focused" as const) : ("blurred" as const),
      cwd: props.cwd,
    })
    const attentionConfig = () => ({ notifications: config().notifications ?? true })
    applyAttention(decideAttention({ kind: "turn.start" }, attentionState(), attentionConfig()))
    let turnDetail: string | undefined
    providerErrorRendered = false
    const turnRules = planMode() ? PLAN_RULES : (config().permissions ?? TUI_DEFAULT_RULES)
    stepAnchor = messages().length
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
        ...(config().retries !== undefined ? { retries: config().retries } : {}),
        ...(config().autoContinue !== undefined ? { autoContinue: config().autoContinue } : {}),
        ...(config().small_model ? { smallModel: config().small_model } : {}),
        ...(costForRef(config().small_model)
          ? { smallModelCost: costForRef(config().small_model) }
          : {}),
        imageInputSupported: imageInputSupported(),
        ask: (request) => askPermission(request, turnRules),
      },
      taskText,
      turnImages.length > 0 ? { images: turnImages } : undefined,
    )
      .then((outcome) => {
        setSessionCost((c) => c + outcome.costUSD)
        const start = turnStartedAt()
        const marker = turnMarker(outcome.usage, outcome.steps, Date.now() - (start ?? Date.now()))
        setStatus(marker)
        setLastTurnMarker(marker)
        void (async () => {
          try {
            episodic.indexJournal(session.journal.path)
          } catch {
            // non-fatal
          }
          // Keep graph.db + project-map.md in step with what this turn edited.
          await codeGraph?.sync().catch(() => {})
          graph = graphDb()
          if (config().memory?.autoReview !== false) {
            const evolved = await evolveAfterTurn({
              provider: freshProvider(),
              model: config().small_model ?? ref,
              journal: session.journal,
              paths,
              skillDir: skillDirs[0] as string,
              skillDirs,
              autoSkills: config().memory?.autoSkills !== false,
              approval: config().memory?.approval === true,
            })
            const evolverCost = costForRef(config().small_model ?? ref)
            if (evolverCost) setSessionCost((c) => c + computeCostUSD(evolved.usage, evolverCost))
            const line = describeEvolution(evolved)
            if (line !== "") push({ kind: "info", text: line })
          }
        })()
      })
      .catch((error: unknown) => {
        turnDetail = error instanceof Error ? error.message : String(error)
        if (!providerErrorRendered) {
          push({
            kind: "error",
            text: `Error: ${turnDetail}`,
          })
        }
      })
      .finally(() => {
        finalizeOpenThinking()
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
    if (setup() || picker() || pagerOpen() || providerKeyStep()) return
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
      if (busy() && (abort || loopAbort) && !interruptArmed) {
        interruptArmed = true
        const wasLoop = loopAbort !== undefined
        abort?.abort()
        loopAbort?.abort()
        pendingAsk()?.resolve("deny")
        push({
          kind: "info",
          text: wasLoop
            ? "(loop interrupted — Ctrl+C again to quit)"
            : "(turn interrupted — Ctrl+C again to quit)",
        })
        setTimeout(() => {
          interruptArmed = false
        }, 3_000)
      } else {
        quit()
      }
      return
    }
    const ask = pendingAsk()
    if (ask && !pagerOpen()) {
      key.preventDefault()
      if (key.name === "y") ask.resolve("allow")
      if (key.name === "n" || key.name === "escape") ask.resolve("deny")
      if (key.name === "a" && ask.quickAdd) {
        applyQuickAdd(ask.quickAdd)
        ask.resolve("allow")
      }
      return
    }
    if (key.ctrl && key.name === "o" && !setup() && !providerKeyStep()) {
      key.preventDefault()
      if (pagerOpen()) closePager()
      else if (!picker()) openPager()
      return
    }
    if (key.ctrl && key.name === "r" && !setup() && !providerKeyStep() && !pagerOpen()) {
      key.preventDefault()
      setThinkingExpanded((expanded) => !expanded)
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
    if (key.ctrl && key.name === "v" && !setup() && !busy() && !providerKeyStep()) {
      void actions.pasteImage()
    }
    if (!setup() && !pagerOpen() && !picker() && !pendingAsk() && !providerKeyStep()) {
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
    if (!setup() && !busy() && !providerKeyStep() && (draft() === "" || historyPos >= 0)) {
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
          setDraft(`/${commandMatchLabel(command, draft())} `)
          setCmdIndex(0)
        }
        return
      }
    }
    if (key.name === "escape" && setup() && config().model) {
      setSetup(null)
      return
    }
    if (key.name === "escape" && providerKeyStep()) {
      setProviderKeyStep(null)
      setDraft("")
      setPasteChips(new Map())
      push({ kind: "info", text: "provider switch cancelled" })
      return
    }
  })

  const mark = renderWordmark()
  const markMode = () => wordmarkMode(dimensions().width)
  const anyOverlayOpen = () =>
    Boolean(picker()) ||
    Boolean(pendingAsk()) ||
    Boolean(providerKeyStep()) ||
    Boolean(loopCard()) ||
    cmdList().length > 0
  const showBigMark = () =>
    messages().length === 0 && !setup() && !anyOverlayOpen() && markMode() !== "plain"
  const showPlainWelcome = () =>
    messages().length === 0 && !setup() && !anyOverlayOpen() && markMode() === "plain"
  const markRows = () => [0, 1, 2, 3, 4, 5]

  const ctxGauge = () => {
    const limit = ctxLimit()
    const used = ctxUsed()
    if (!limit) return used > 0 ? `ctx ${humanizeTokens(used)}` : ""
    const pct = Math.min(100, Math.round((used / limit) * 100))
    return `ctx ${humanizeTokens(used)}/${humanizeTokens(limit)} (${pct}%)`
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
        <text fg={themeTokens().muted}>butterfly </text>
        <text>
          <b>code</b>
        </text>
        <text fg={themeTokens().muted}>
          {modelRef() ? `  ·  ${modelRef()}` : "  ·  not configured"}
        </text>
        <Show when={reasoning()}>
          <text fg={themeTokens().accent}>{`  ·  think:${reasoning()}`}</text>
        </Show>
        <Show when={planMode()}>
          <text fg={themeTokens().warn}>{"  ·  PLAN (read-only)"}</text>
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
                    <text fg={themeTokens().muted}>
                      Pick a provider (type its number or name, then Enter):
                    </text>
                    <For each={PROVIDERS}>
                      {(choice, index) => (
                        <text>
                          {`  ${index() + 1}  ${choice.id}${choice.needsKey ? "" : "  (no key needed)"}`}
                        </text>
                      )}
                    </For>
                  </Show>
                  <Show when={setup()?.stage === "key"}>
                    <text fg={themeTokens().muted}>
                      Paste your API key and press Enter. It is stored in
                      ~/.config/butterfly/butterfly.jsonc (visible while typing).
                    </text>
                  </Show>
                  <Show when={setup()?.stage === "model"}>
                    <text fg={themeTokens().muted}>{`Model id for this provider — e.g. ${
                      PROVIDERS.find((p) => p.id === (setup() as { provider?: string }).provider)
                        ?.example ?? "model-id"
                    }`}</text>
                    <Show when={setupModels() !== ""}>
                      <box marginTop={1}>
                        <text fg={themeTokens().muted}>{setupModels()}</text>
                      </box>
                    </Show>
                  </Show>
                </box>
                <box marginTop={1} flexDirection="column">
                  <For each={messages().slice(-3)}>
                    {(message) => (
                      <text
                        fg={message.kind === "error" ? themeTokens().error : themeTokens().muted}
                      >
                        {message.text}
                      </text>
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
                          {(row) => <text fg={themeTokens().muted}>{mark.left[row]}</text>}
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
                            <text fg={themeTokens().muted}>{mark.left[row]}</text>
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
                    <text fg={themeTokens().muted}>
                      the harness-first coding agent — /help for commands
                    </text>
                  </box>
                </box>
              }
            >
              <Show
                when={!showPlainWelcome()}
                fallback={
                  <box
                    flexGrow={1}
                    justifyContent="center"
                    alignItems="center"
                    flexDirection="column"
                  >
                    <box flexDirection="row">
                      <text fg={themeTokens().muted}>butterfly </text>
                      <text>
                        <b>code</b>
                      </text>
                    </box>
                    <box marginTop={1}>
                      <text fg={themeTokens().muted}>
                        the harness-first coding agent — /help for commands
                      </text>
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
                  viewportOptions={{ paddingRight: 2 }}
                  verticalScrollbarOptions={{
                    trackOptions: {
                      backgroundColor: themeTokens().bg,
                      foregroundColor: themeTokens().border,
                    },
                  }}
                >
                  <For each={messages()}>
                    {(message, index) => {
                      const inlineThink =
                        message.kind === "assistant" ? splitThink(message.text) : undefined
                      return (
                        <Show
                          when={message.kind === "assistant"}
                          fallback={
                            <Show
                              when={message.kind === "thinking"}
                              fallback={
                                <box marginTop={messageMarginTop(message)} flexDirection="column">
                                  <Show
                                    when={message.errorInfo}
                                    fallback={
                                      <Show
                                        when={
                                          message.todos !== undefined &&
                                          index() === latestTodoIndex()
                                        }
                                        fallback={
                                          <Show
                                            when={message.command !== undefined}
                                            fallback={
                                              <Show
                                                when={message.isCall}
                                                fallback={
                                                  <MessageLines
                                                    text={
                                                      message.kind === "user"
                                                        ? `❯ ${message.text}`
                                                        : message.text
                                                    }
                                                    tone={
                                                      message.kind === "tool" ||
                                                      message.kind === "info"
                                                        ? themeTokens().muted
                                                        : message.kind === "error"
                                                          ? themeTokens().error
                                                          : undefined
                                                    }
                                                    structured={message.structured}
                                                  />
                                                }
                                              >
                                                <ToolCallRow text={message.text} />
                                              </Show>
                                            }
                                          >
                                            <box flexDirection="column">
                                              <box flexDirection="row">
                                                <text fg={themeTokens().accent}>{"$ "}</text>
                                                <text>{message.command}</text>
                                                <box flexGrow={1} />
                                                <text
                                                  fg={
                                                    message.exitCode === 0
                                                      ? themeTokens().muted
                                                      : themeTokens().error
                                                  }
                                                >
                                                  {message.exitCode === 0
                                                    ? "ok"
                                                    : `exit ${message.exitCode}`}
                                                </text>
                                              </box>
                                              <Show
                                                when={
                                                  message.commandBody !== undefined &&
                                                  message.commandBody !== ""
                                                }
                                              >
                                                <text fg={themeTokens().muted}>
                                                  {message.commandBody}
                                                </text>
                                              </Show>
                                            </box>
                                          </Show>
                                        }
                                      >
                                        <box
                                          border
                                          borderStyle="rounded"
                                          borderColor={themeTokens().border}
                                          flexDirection="column"
                                          paddingLeft={1}
                                          paddingRight={1}
                                        >
                                          <text fg={themeTokens().muted}>
                                            {`todos ${(message.todos ?? []).filter((item) => item.status === "completed").length}/${(message.todos ?? []).length}`}
                                          </text>
                                          <For each={message.todos ?? []}>
                                            {(item) => (
                                              <text
                                                fg={
                                                  item.status === "in_progress"
                                                    ? themeTokens().accent
                                                    : themeTokens().muted
                                                }
                                              >
                                                {`${TODO_GLYPH[item.status]} ${item.text}`}
                                              </text>
                                            )}
                                          </For>
                                        </box>
                                      </Show>
                                    }
                                  >
                                    {(info: Accessor<ProviderErrorInfo>) => (
                                      <box flexDirection="column">
                                        <text fg={themeTokens().error}>{message.text}</text>
                                        <Show when={errorCardDetail(info(), message.text)}>
                                          {(detail: Accessor<string>) => (
                                            <text fg={themeTokens().muted}>{detail()}</text>
                                          )}
                                        </Show>
                                      </box>
                                    )}
                                  </Show>
                                  <Show when={message.diff}>
                                    <box paddingLeft={2} flexShrink={0}>
                                      <diff
                                        diff={message.diff ?? ""}
                                        view="unified"
                                        syntaxStyle={SYNTAX}
                                        filetype={filetypeOf(message.path)}
                                        wrapMode="none"
                                        addedSignColor={themeTokens().diffAdd}
                                        removedSignColor={themeTokens().diffDel}
                                        addedBg={themeTokens().diffAddBg}
                                        removedBg={themeTokens().diffDelBg}
                                        contextBg={themeTokens().diffContextBg}
                                        lineNumberFg={themeTokens().diffLineNumber}
                                        lineNumberBg={themeTokens().diffLineNumberBg}
                                      />
                                    </box>
                                  </Show>
                                </box>
                              }
                            >
                              <ThinkingBlock
                                thinkingText={message.text}
                                open={message.thinkClosedAt === undefined}
                                startedAt={message.thinkStartedAt}
                                closedAt={message.thinkClosedAt}
                                expanded={thinkingExpanded()}
                              />
                            </Show>
                          }
                        >
                          <box flexDirection="column">
                            <Show when={inlineThink && inlineThink.thinking !== ""}>
                              <ThinkingBlock
                                thinkingText={inlineThink?.thinking ?? ""}
                                open={
                                  (inlineThink?.open ?? false) &&
                                  message.thinkClosedAt === undefined
                                }
                                startedAt={message.thinkStartedAt}
                                closedAt={message.thinkClosedAt}
                                expanded={thinkingExpanded()}
                              />
                            </Show>
                            <Show when={inlineThink && inlineThink.rest.trim() !== ""}>
                              <box marginTop={1} flexShrink={0}>
                                <markdown
                                  content={inlineThink?.rest.trim() ?? ""}
                                  syntaxStyle={SYNTAX}
                                  streaming={busy() && index() === messages().length - 1}
                                  internalBlockMode="top-level"
                                />
                              </box>
                            </Show>
                          </box>
                        </Show>
                      )
                    }}
                  </For>
                </scrollbox>
              </Show>
            </Show>
          </Show>
        </Show>
      </box>

      <Show when={loopCard()}>
        {(card: Accessor<LoopCardState>) => (
          <box
            flexShrink={0}
            border
            borderStyle="rounded"
            borderColor={themeTokens().accent}
            paddingLeft={1}
            flexDirection="column"
          >
            <text fg={themeTokens().accent}>{"loop running — Ctrl+C to interrupt"}</text>
            <text>{loopCardText(card())}</text>
          </box>
        )}
      </Show>

      <Show when={pendingAsk()}>
        {(ask: Accessor<PendingAsk>) => (
          <box
            flexShrink={0}
            border
            borderStyle="rounded"
            borderColor={themeTokens().accent}
            paddingLeft={1}
            flexDirection="column"
          >
            <box flexDirection="row">
              <text fg={themeTokens().accent}>approve? </text>
              <text>{middleEllipsize(ask().text, Math.max(20, dimensions().width - 14))}</text>
            </box>
            <Show
              when={!pagerOpen()}
              fallback={<text fg={themeTokens().warn}>close the pager (Esc) to answer</text>}
            >
              <box flexDirection="row">
                <text fg={themeTokens().muted}>[y]es · [n]o</text>
                <Show when={ask().quickAdd}>
                  {(qa: Accessor<QuickAddOffer>) => (
                    <text fg={themeTokens().muted}>{` · [a]lways "${qa().pattern}"`}</text>
                  )}
                </Show>
              </box>
            </Show>
          </box>
        )}
      </Show>

      <Show when={providerKeyStep()}>
        {(step: Accessor<{ provider: string; hasExisting: boolean }>) => (
          <box
            flexShrink={0}
            border
            borderStyle="rounded"
            borderColor={themeTokens().accent}
            paddingLeft={1}
            flexDirection="column"
          >
            <text fg={themeTokens().accent}>{`${step().provider} API key`}</text>
            <text fg={themeTokens().muted}>
              {step().hasExisting
                ? "Enter keeps the saved key · type to replace · Esc cancels"
                : "paste your API key · Esc cancels"}
            </text>
          </box>
        )}
      </Show>

      <Show when={picker()}>
        {(p: Accessor<{ title: string; note?: string; index: number; filter: string }>) => {
          const items = () => pickerItems()
          const windowStart = () => Math.max(0, Math.min(p().index - 4, items().length - 9))
          return (
            <box
              flexShrink={0}
              border
              borderStyle="rounded"
              borderColor={themeTokens().accent}
              paddingLeft={1}
              flexDirection="column"
            >
              <text fg={themeTokens().accent}>{p().title}</text>
              <Show when={p().note}>
                {(note: Accessor<string>) => <text fg={themeTokens().warn}>{` ${note()}`}</text>}
              </Show>
              <Show when={p().filter !== ""}>
                <text
                  fg={themeTokens().warn}
                >{`  filter: ${p().filter}  (${items().length} match${items().length === 1 ? "" : "es"})`}</text>
              </Show>
              <Show
                when={items().length > 0}
                fallback={<text fg={themeTokens().muted}> no matches — Backspace to widen</text>}
              >
                <For each={items().slice(windowStart(), windowStart() + 9)}>
                  {(item, i) => (
                    <box flexDirection="row">
                      <text
                        fg={
                          windowStart() + i() === p().index
                            ? themeTokens().accent
                            : themeTokens().muted
                        }
                      >
                        {windowStart() + i() === p().index ? "❯ " : "  "}
                      </text>
                      <text
                        fg={windowStart() + i() === p().index ? undefined : themeTokens().muted}
                      >
                        {item.label}
                      </text>
                    </box>
                  )}
                </For>
              </Show>
              <Show when={items().length > 9}>
                <text fg={themeTokens().muted}>{`  … ${items().length} total`}</text>
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
          borderColor={themeTokens().border}
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
            {(row) => {
              const label = () => commandMatchLabel(row.command, draft())
              const reason = () => commandMatchReason(row.command, draft())
              return (
                <box flexDirection="row">
                  <text
                    fg={row.absolute === cmdIndex() ? themeTokens().accent : themeTokens().muted}
                  >
                    {row.absolute === cmdIndex() ? "❯ " : "  "}
                  </text>
                  <text fg={row.absolute === cmdIndex() ? undefined : themeTokens().muted}>
                    {`/${label()}${row.command.args ? ` ${row.command.args}` : ""}`.padEnd(18)}
                  </text>
                  <text fg={themeTokens().muted}>
                    {reason()
                      ? `${row.command.description} (${reason()})`
                      : row.command.description}
                  </text>
                </box>
              )
            }}
          </For>
          <text fg={themeTokens().muted}>
            {` ↑↓ select · Tab complete · Enter run${cmdList().length > 8 ? ` · ${cmdList().length} commands` : ""}`}
          </text>
        </box>
      </Show>

      <Show when={attachedImages().length > 0}>
        <box flexShrink={0} paddingLeft={1} flexDirection="row">
          <text fg={themeTokens().accent}>
            {`attached: ${attachedImages().length} image${attachedImages().length === 1 ? "" : "s"} — `}
          </text>
          <text fg={themeTokens().muted}>
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
            if (!setup() && !busy() && !picker() && !providerKeyStep()) {
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
            if (!setup() && !picker() && !pagerOpen() && !providerKeyStep()) {
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
            if (
              !setup() &&
              !busy() &&
              !picker() &&
              !providerKeyStep() &&
              isMentionTrigger(previous, value)
            ) {
              openMentionPicker()
            }
          }}
          onSubmit={() => submit(draft())}
          placeholder={
            setup()
              ? setupPrompt()
              : providerKeyStep()
                ? `${providerKeyStep()?.provider} API key`
                : busy()
                  ? "working… (Ctrl+C to interrupt)"
                  : "describe a task — /help for commands"
          }
        />
      </box>

      <box flexShrink={0} height={1} paddingLeft={1} flexDirection="row">
        <text fg={busy() ? themeTokens().accent : themeTokens().muted}>
          {busy()
            ?
              `${SPINNER[spin()]} thinking… ${elapsedText()}  `
            : status()
              ? `${status()}  `
              :
                `${modelRef() ?? "not configured"}  ·  ${basename(props.cwd)}  ·  /help for commands`}
        </text>
        <Show when={metersFitAt(dimensions().width)}>
          <box flexGrow={1} />
          <Show when={ctxGauge() !== ""}>
            <text fg={ctxDanger() ? themeTokens().warn : themeTokens().muted}>{ctxGauge()}</text>
          </Show>
          <Show when={sessionCost() > 0}>
            <text fg={themeTokens().muted}>{`  ·  ${formatUSD(sessionCost())}`}</text>
          </Show>
          <Show when={queued().length > 0}>
            <text fg={themeTokens().warn}>{`  ·  ${queued().length} (queued)`}</text>
          </Show>
        </Show>
      </box>
    </box>
  )
}
