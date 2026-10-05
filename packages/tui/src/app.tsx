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
  cacheHitRate,
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
  describeVerification,
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
  killCommand,
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
  OLLAMA_DEFAULT_BASE,
  type PermissionRules,
  type ProviderErrorInfo,
  parseModelRef,
  parseReviewArg,
  planQuickAdd,
  preloadHandoff,
  prepareImageAttachments,
  presetBaseURL,
  presetEnvKey,
  probeOllamaContext,
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
  type SubagentUpdate,
  safeRewindIndex,
  saveGlobalConfig,
  saveHandoff,
  servedContextWarning,
  setHookEnabled,
  setPermissionRule,
  skillStatus,
  skillsIndex,
  stageAllTracked,
  type TaskToolOptions,
  ToolRegistry,
  todosFromTimeline,
  todoTool,
  touchFrecency,
  type Usage,
  verifyLatestTurn,
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
import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  type Setter,
  Show,
} from "solid-js"
import { capOsc52Text, saveClipboardImage } from "./clipboard"
import {
  type CommandActions,
  commandMatches,
  commandMatchLabel,
  commandMatchReason,
  expandTemplate,
  findCommand,
  loadCustomCommands,
  nextEffort,
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
  type AgentEntry,
  compactToolResult,
  type LayoutPlan,
  liveTail,
  planLayout,
  type ShellView,
  type SidebarPref,
  shellRow,
  shortElapsed,
  type TodoItemView,
  type ToolTone,
  toolTone,
} from "./layout"
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
import { AgentsPane, AgentViewHeader, PinnedStrip, ShellPane, Sidebar } from "./panels"
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

/** A todo card item, duck-typed off tool.result.meta (not a core import).
 * Statuses mirror todoTool's own enum. */
interface TodoMeta {
  text: string
  status: "pending" | "in_progress" | "completed"
}

interface Message {
  kind: "user" | "assistant" | "tool" | "info" | "error" | "thinking"
  text: string
  /** Live tool-progress line (callId) — replaced in place, removed on the result. */
  progressId?: string
  /** Tool-call rows: the call's id and tool, so its result can fold into the row. */
  callId?: string
  toolName?: string
  /** Tool-call rows: one-line outcome folded in from the result (layout.compactToolResult). */
  summary?: string
  /** Tool-call rows: still executing (live sessions only). */
  pending?: boolean
  /** Tool-call rows: the call failed (its error sits right under the row). */
  failed?: boolean
  /** Result blocks: the call id they belong to — they sit under that row. */
  resultOf?: string
  /** Running command rows: the live tail of the command's output. */
  liveOutput?: string
  /** An agent action (tool call, result, command cell, diff) rather than
   * words to the user; rendered behind a left rail. */
  action?: boolean
  /** Tool-call rows: when the call started (live) — drives "running 12s". */
  startedAt?: number
  /** Command cells: how long the command ran. */
  durationMs?: number
  /**
   * Streaming channel for the message being written now. Deltas update this
   * signal (and `text`) in place: <For> keys rows by identity, so a new object
   * per token would rebuild the row's <markdown> every delta. Rows read
   * `liveText(message)`.
   */
  live?: { text: Accessor<string>; set: Setter<string> }
  /** Unified diff for edit results — rendered with the diff element. */
  diff?: string
  path?: string
  /** Todo card, present on the todo tool's UI-only meta. */
  todos?: TodoMeta[]
  /** Bash command cell, present on the bash tool's UI-only meta. */
  command?: string
  exitCode?: number
  /** Pre-formatted dim output body for the command cell, computed when the
   * message is built (the card has no access to the raw tool output). */
  commandBody?: string
  /** Structured provider error; absent for non-provider errors, which render
   * plain `text`. */
  errorInfo?: ProviderErrorInfo
  /**
   * Thinking-block timing, view-state only. Reasoning is never journaled, so
   * these are undefined on a resumed message and the collapsed line shows
   * "thought" with no duration. Used by both native reasoning messages and
   * assistant messages carrying an inline <think> block.
   */
  thinkStartedAt?: number
  /** Set once when the block closes (first text-delta, or the </think> tag);
   * forced closed on "finish" so a block never streams forever. */
  thinkClosedAt?: number
  /** Set on tool-call rows only: starts a new tool group (two-tone name/args
   * and a blank line before it). A result row continues the group with no gap. */
  isCall?: boolean
  /** `text` is structured command output (/status, /context, /doctor, /help,
   * /sessions), rendered as muted labels with fg values per line. */
  structured?: boolean
}

function filetypeOf(path: string | undefined): string | undefined {
  const ext = path?.split(".").pop()?.toLowerCase()
  if (ext === "ts" || ext === "tsx" || ext === "mts" || ext === "cts") return "typescript"
  if (ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs") return "javascript"
  if (ext === "md") return "markdown"
  return undefined
}

/** The review card, built from the journaled event so live and /resume
 * renders match by construction. */
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

/** A message's current text — the live streaming channel when it has one. */
function liveText(message: Message): string {
  return message.live ? message.live.text() : message.text
}

export function timelineToMessages(timeline: import("@butterfly/core").SessionEvent[]): Message[] {
  const restored: Message[] = []
  const callTimes = new Map<string, number>()
  for (const event of timeline) {
    if (event.type === "message.user")
      restored.push(
        event.synthetic === true
          ? { kind: "info", text: "auto-continue: the harness nudged the model to keep going" }
          : { kind: "user", text: event.text },
      )
    else if (event.type === "message.assistant") {
      // Kept when there is an answer or an inline <think> block (inline
      // reasoning is journaled, so it survives /resume). A pure tool-call step
      // renders nothing.
      const split = splitThink(event.text)
      if (split.rest.trim() !== "" || split.thinking !== "") {
        restored.push({ kind: "assistant", text: event.text })
      }
    } else if (event.type === "tool.call") {
      callTimes.set(event.callId, Date.parse(event.time))
      restored.push(toolCallMessage(event.name, event.input, event.callId))
    } else if (event.type === "tool.result") {
      // Journal timestamps give replayed command cells their duration too.
      const started = callTimes.get(event.callId)
      const took = started !== undefined ? Date.parse(event.time) - started : undefined
      const folded = applyToolResult(
        restored,
        event.callId,
        event.output,
        event.isError,
        event.meta,
        took !== undefined && !Number.isNaN(took) ? took : undefined,
      )
      restored.length = 0
      restored.push(...folded)
    } else if (event.type === "session.compacted")
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

/** Duck-types the todo tool's UI-only `meta.todos`. A malformed or foreign
 * meta degrades to "no card": every item needs string text and a known status. */
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

/** Caps a fallback JSON dump at a token boundary (comma/space/colon/brace),
 * never mid-token, with a trailing "…" when truncated. */
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

/**
 * One-line per-tool summaries for the tool-call row: read/edit show the path,
 * grep the pattern (+glob), glob the pattern. Everything else, including bash
 * (whose result cell shows `$ command`), uses the capped JSON fallback.
 */
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
  if (name === "bash") {
    const command = str(args.command)
    if (command !== undefined) return capAtTokenBoundary(command.replace(/\s+/g, " "), 100)
  }
  // Readable previews instead of raw JSON for the op-dispatched tools.
  if (name === "todo" && Array.isArray(args.items)) return `${args.items.length} items`
  if (name === "task") {
    if (Array.isArray(args.tasks)) {
      const first = (args.tasks[0] as { task?: unknown } | undefined)?.task
      const brief = typeof first === "string" ? `: ${first.replace(/\s+/g, " ")}` : ""
      return capAtTokenBoundary(`${args.tasks.length} subagents${brief}`, 90)
    }
    const op = str(args.op)
    if (op && op !== "run") return [op, str(args.worktree)].filter(Boolean).join(" ")
    const brief = str(args.task)
    if (brief !== undefined) return capAtTokenBoundary(brief.replace(/\s+/g, " "), 90)
  }
  if (
    name === "explore" ||
    name === "web" ||
    name === "memory" ||
    name === "skill" ||
    name === "mcp"
  ) {
    const op = str(args.op)
    const target = [args.path, args.symbol, args.query, args.url, args.name, args.server, args.tool]
      .map(str)
      .find((v) => v !== undefined)
    if (op !== undefined || target !== undefined) {
      return capAtTokenBoundary([op, target].filter(Boolean).join(" "), 100)
    }
  }
  return capAtTokenBoundary(JSON.stringify(input), 100)
}

/** tool.call's one-line preview, shared by the live path and
 * timelineToMessages so a resumed session renders identically. `isCall`
 * marks it as the start of a tool group. */
function toolCallMessage(name: string, input: unknown, callId?: string): Message {
  return {
    kind: "tool",
    text: `${name} ${toolCallArgs(name, input)}`,
    isCall: true,
    action: true,
    toolName: name,
    ...(callId !== undefined ? { callId } : {}),
  }
}

/** tool.result's message, shared by the live path and timelineToMessages.
 * Meta shapes are mutually exclusive in practice, so spreading all three is safe. */
function toolResultMessage(output: string, isError: boolean, meta: unknown): Message {
  const bash = metaBash(meta)
  return {
    kind: isError ? "error" : "tool",
    action: true,
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

/**
 * Folds a tool result into the transcript: a routine success (read, glob,
 * grep, plan update) becomes a one-line summary on the call's row, e.g.
 * "read src/a.ts · 342 lines". Failures, diffs, command cells and anything
 * without a compact form keep a full block. Shared by live and /resume.
 */
function applyToolResult(
  list: Message[],
  callId: string,
  output: string,
  isError: boolean,
  meta: unknown,
  durationMs?: number,
): Message[] {
  const at = list.findIndex((m) => m.isCall && m.callId === callId)
  const row = at >= 0 ? list[at] : undefined
  const took = durationMs ?? (row?.startedAt !== undefined ? Date.now() - row.startedAt : undefined)
  const bash = metaBash(meta)
  if (row && bash) {
    // The call row becomes the command cell: one "$ cmd  ok · 3s" block.
    const next = [...list]
    next[at] = {
      ...row,
      kind: isError ? "error" : "tool",
      pending: false,
      command: bash.command,
      exitCode: bash.exitCode,
      commandBody: formatCommandBody(output, isError),
      ...(took !== undefined ? { durationMs: took } : {}),
    }
    return next
  }
  const todos = metaTodos(meta)?.todos
  const diff = metaDiff(meta)
  const summary =
    !isError && row?.toolName && diff === undefined && metaBash(meta) === undefined
      ? todos
        ? `plan ${todos.filter((t) => t.status === "completed").length}/${todos.length}`
        : compactToolResult(row.toolName, output)
      : undefined
  const next = [...list]
  if (row && summary !== undefined) {
    next[at] = { ...row, summary, pending: false }
    return next
  }
  if (!row) {
    next.push(toolResultMessage(output, isError, meta))
    return next
  }
  // A result that needs its own block goes directly under its call, not at
  // the bottom beneath later calls of the same batch.
  next[at] = {
    ...row,
    pending: false,
    ...(isError ? { failed: true, summary: "failed" } : {}),
    ...(!isError && diff ? { summary: editSummary(output) } : {}),
  }
  const block: Message = {
    ...toolResultMessage(output, isError, meta),
    resultOf: callId,
    // The row already says what happened; the diff speaks for itself.
    ...(!isError && diff ? { text: "" } : {}),
  }
  let insert = at + 1
  while (insert < next.length && next[insert]?.resultOf === callId) insert += 1
  next.splice(insert, 0, block)
  return next
}

/** "Edited a.ts (2 replacements)." -> "2 replacements"; else a short first line. */
function editSummary(output: string): string {
  const count = output.match(/\((\d+ replacements?)\)/)?.[1]
  if (count) return count
  const first = (output.split("\n")[0] ?? "").trim().replace(/\.$/, "")
  return first.length > 48 ? `${first.slice(0, 47)}…` : first || "done"
}

/** Provider error card headline, prefixed with a plain "error:" tag. */
function errorCardHeadline(info: ProviderErrorInfo): string {
  return `error: ${describeProviderError(info)}`
}

/** The error card's dim second line (`info.detail`), skipped when it would
 * repeat the headline. */
function errorCardDetail(info: ProviderErrorInfo, headline: string): string | undefined {
  const detail = info.detail
  if (detail === undefined || detail === "") return undefined
  return headline.includes(detail) ? undefined : detail
}

/** Mirrors todo.ts's MARK constants. */
const TODO_GLYPH: Record<TodoMeta["status"], string> = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]",
}

/**
 * The thinking block, shared by native reasoning streams and inline <think>
 * blocks. While open it shows a rolling last-3-lines preview; closed, it
 * collapses to one line with a duration when timing is known (never for a
 * resumed message, since reasoning is not journaled).
 */
/** First meaningful line of a thought, trimmed to fit one row. */
export function thinkingGist(text: string, max = 72): string {
  const line =
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "") ?? ""
  return line.length > max ? `${line.slice(0, max - 3)}...` : line
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
  // Thinking is always italic and dim so it never reads like the answer.
  // Collapsed, it keeps a one-line gist.
  const gist = () => thinkingGist(props.thinkingText)
  return (
    <box flexDirection="column">
      <Show
        when={props.open}
        fallback={
          <text>
            <Tint fg={themeTokens().muted} italic>
              {seconds() !== undefined ? `thought for ${seconds()}s` : "thought"}
            </Tint>
            <Tint fg={themeTokens().muted} italic>
              {!props.expanded && gist() !== "" ? ` - ${gist()}` : ""}
            </Tint>
            <Tint fg={themeTokens().border}>
              {!props.expanded && props.thinkingText.trim() !== "" ? "  (ctrl+r)" : ""}
            </Tint>
          </text>
        }
      >
        <box flexDirection="column">
          <text>
            <Tint fg={themeTokens().muted} italic>
              {"thinking…"}
            </Tint>
          </text>
          <For each={props.thinkingText.split("\n").slice(-3)}>
            {(line) => (
              <text>
                <Tint fg={themeTokens().muted} italic>{`  ${line}`}</Tint>
              </text>
            )}
          </For>
        </box>
      </Show>
      <Show when={props.expanded && !props.open && props.thinkingText.trim() !== ""}>
        <box paddingLeft={2} flexDirection="column">
          <For each={props.thinkingText.trim().split("\n")}>
            {(line) => (
              <text>
                <Tint fg={themeTokens().muted} italic>
                  {line}
                </Tint>
              </text>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}

/**
 * Splits one line into label/value at the first run of 2+ spaces, the column
 * separator used by the structured command-output builders. Returns undefined
 * for lines with no such column (titles, hints, JSON lines).
 * The `.*?` must stay lazy: a greedy match splits at the last run instead and
 * puts the value on the wrong side for multi-column lines.
 */
export function splitLabelValue(line: string): { label: string; value: string } | undefined {
  const match = line.match(/^(\s*\S.*?)( {2,})(\S.*)$/)
  if (!match) return undefined
  const [, label, gap, value] = match
  if (label === undefined || gap === undefined || value === undefined) return undefined
  return { label: `${label}${gap}`, value }
}

/**
 * One line of a message. Rendered per line because OpenTUI measures a
 * `<text>`'s height from wrap breaks, not literal "\n"s, so a multi-line
 * `<text>` under-reports its height and the scrollbox mismeasures (phantom
 * scrollbar, first line scrolled out of view). `structured` splits each line
 * into a muted label and fg value.
 */
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

/** A full message body, one row per line (see MessageLine). */
function MessageLines(props: { text: string; tone: string | undefined; structured?: boolean }) {
  return (
    <box flexDirection="column">
      <For each={props.text === "" ? [] : props.text.split("\n")}>
        {(line) => (
          <MessageLine line={line} tone={props.tone} structured={props.structured ?? false} />
        )}
      </For>
    </box>
  )
}

/**
 * Tool-call row: tool name in fg, args muted. `text` is always
 * `${name} ${args}` and tool names never contain a space, so splitting on the
 * first space is exact.
 */
/**
 * A coloured run inside a <text>. opentui-solid 0.4.5 only applies span
 * colour from `style` (a bare `fg` is ignored) and types <span> props as
 * `{}`, so the cast is confined to this helper.
 */
function Tint(props: { fg: string; italic?: boolean; bold?: boolean; children: string }) {
  return (
    <span
      {...({
        style: {
          fg: props.fg,
          ...(props.italic ? { italic: true } : {}),
          ...(props.bold ? { bold: true } : {}),
        },
      } as unknown as Record<string, never>)}
    >
      {props.children}
    </span>
  )
}

/** Verb colour per tool family (layout.toolTone). */
function toneColor(tone: ToolTone): string {
  const t = themeTokens()
  switch (tone) {
    case "read":
      return t.link
    case "edit":
      return t.warn
    case "shell":
      return t.accent
    case "agent":
      return t.type
    case "plan":
      return t.muted
    default:
      return t.fg
  }
}

function ToolCallRow(props: {
  text: string
  summary?: string
  failed?: boolean
  pending?: boolean
  /** Live elapsed for a running call ("running 12s"), from the 1s ticker. */
  runningFor?: string
}) {
  const spaceIndex = () => props.text.indexOf(" ")
  const name = () => (spaceIndex() === -1 ? props.text : props.text.slice(0, spaceIndex()))
  const args = () => (spaceIndex() === -1 ? "" : props.text.slice(spaceIndex() + 1))
  // One text node with spans: verb (coloured by tool family), args and the
  // folded outcome wrap as one line. A shell command reads "$ npm test".
  return (
    <text>
      <Tint fg={toneColor(toolTone(name()))}>{name() === "bash" ? "$" : name()}</Tint>
      <Tint fg={name() === "bash" ? themeTokens().fg : themeTokens().muted}>
        {args() !== "" ? ` ${args()}` : ""}
      </Tint>
      <Tint fg={props.failed ? themeTokens().error : themeTokens().success}>
        {props.summary !== undefined ? ` · ${props.summary}` : ""}
      </Tint>
      <Tint fg={themeTokens().muted}>
        {props.pending && props.summary === undefined
          ? props.runningFor
            ? `  running ${props.runningFor}`
            : " ..."
          : ""}
      </Tint>
    </text>
  )
}

/** Blank-line rhythm: every tool call starts a new group with a gap; its
 * result continues the group with no gap. `info` is spaced like `user`. */
function messageMarginTop(message: Message, previous?: Message): number {
  // Consecutive actions (calls, results, command cells) form one group
  // sharing one rail.
  if (message.action && previous?.action) return 0
  return message.kind === "user" || message.kind === "info" || message.isCall ? 1 : 0
}

/**
 * True when `value` is `previous` plus one freshly typed "@" at a word
 * boundary: the @-mention trigger. Ignores mid-word "@" (emails) and bulk
 * draft changes (paste, /resume).
 */
function isMentionTrigger(previous: string, value: string): boolean {
  if (value.length !== previous.length + 1 || !value.endsWith("@")) return false
  const before = previous.at(-1)
  return before === undefined || /\s/.test(before)
}

/**
 * Formats a picked path for insertion after the trigger `@`. Paths with
 * spaces are quoted so they round-trip through `extractMentions`.
 */
function mentionToken(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path
}

/**
 * Detects a typed/pasted image path at the tail of the composer and resolves
 * it against `cwd`. The file must exist, so prose like "see cat.png" doesn't
 * become a chip. Size/count caps are enforced at submit time, not here.
 */
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

/**
 * Clears the OSC 9;4 progress indicator on exit. `renderer.destroy()` can't:
 * OpenTUI has no progress concept, so the taskbar spinner would keep running.
 * Called from every exit path; written raw because the renderer is gone by then.
 */
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

/**
 * The narrowed "always allow" rule the [a] key would commit, computed at ask
 * time so the preview shown is exactly what gets written.
 */
interface QuickAddOffer {
  tool: string
  pattern: string
  rules: PermissionRules
}

interface PendingAsk {
  text: string
  /** Absent for plain confirmations and for asks planQuickAdd refused (would
   * widen an existing deny); either way no [a] option is offered. */
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

/**
 * One line per approval prompt. `note` is the tool's disclosure of what the
 * target alone doesn't say (e.g. third-party hosts a `web` fetch transits).
 * Structurally typed against core's AskRequest (not re-exported).
 */
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

/**
 * Plan mode: read-only for the workspace; mutations are denied, not asked.
 * `web` is allowed since it changes nothing locally.
 */
const PLAN_RULES: PermissionRules = {
  "*": "allow",
  bash: "deny",
  edit: "deny",
  memory: "deny",
  web: "allow",
}

const PLAN_PREFIX =
  "[PLAN MODE — read-only. Investigate with read/glob/grep/explore, then produce a concrete numbered implementation plan (files to change, exact steps, risks, verification). Do NOT modify anything; edit/bash are disabled.]"

/**
 * `/loop run`'s default when butterfly.jsonc has no `permissions`. No "ask"
 * entries: loop iterations are unattended, so an ask would fail every tool
 * call. Mirrors cli/loop.ts's LOOP_RULES.
 */
const LOOP_TUI_RULES: PermissionRules = {
  "*": "allow",
  edit: { "**/.env*": "deny", ".env*": "deny" },
}

/** Same cap core's snapshot.ts uses: git can hang for minutes on some
 * platforms. A timeout reads as "couldn't tell" and fails open (see loopRun). */
const GIT_STATUS_TIMEOUT_MS = 15_000

/** Mirrors cli/loop.ts's PLANNER_PROMPT (a single text-only call). */
const LOOP_PLANNER_PROMPT = `You are the planning stage of an autonomous coding loop. Break the specification into 2-10 SMALL, independently verifiable tasks. Each task must be completable in one focused session and checkable by the project's test/build gates.

Reply with ONLY a JSON array, no prose:
[{"title":"short imperative title","spec":"exact, self-contained instructions","blockedBy":[0]}]
"blockedBy" lists 0-based indexes of tasks that must finish first. Prefer independent tasks; add dependencies only when strictly required. Implement nothing yourself.`

/** Same paths as cli/loop.ts, so `/loop status` and `butterfly loop status`
 * read the same queue/handoff. */
function loopPaths(cwd: string): { queue: string; handoff: string; sessions: string } {
  return {
    queue: join(cwd, ".butterfly", "queue.db"),
    handoff: join(cwd, ".butterfly", "handoff.json"),
    sessions: join(cwd, ".butterfly", "sessions"),
  }
}

export function App(props: { cwd: string; config: ButterflyConfig; home?: string }) {
  const home = props.home ?? homedir()
  /** Shortens paths for /status and /doctor rows so they don't wrap: home
   * becomes "~", then anything still too long is middle-ellipsized. */
  const displayPath = (path: string): string =>
    middleEllipsize(path.startsWith(home) ? `~${path.slice(home.length)}` : path, 70)
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()

  // Terminal window focus (not in-app focus). Assumed focused at launch;
  // terminals without focus tracking stay "focused", so no notifications.
  const [focused, setFocused] = createSignal(true)
  onFocus(() => setFocused(true))
  onBlur(() => setFocused(false))

  /**
   * Applies attention actions from the core decider: notify and title via
   * OpenTUI's APIs. Progress (OSC 9;4) has no OpenTUI API, so it goes through
   * `renderer.writeOut`, which serializes with frame flushes; a raw
   * process.stdout.write could land mid-frame. `writeOut` is typed private,
   * hence the cast. Best-effort: never allowed to crash a turn.
   */
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
        // best-effort; must never interrupt a turn
      }
    }
  }

  const [config, setConfig] = createSignal(props.config)

  // Theme resolved synchronously on mount (pinned theme, else dark) so the
  // first render is right and each mount starts deterministic. Auto
  // light/dark detection follows below, only when nothing is pinned.
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

  /** The plan, kept outside the transcript so it stays visible while it scrolls. */
  const [planTodos, setPlanTodos] = createSignal<TodoItemView[]>([])
  /** Every subagent this session spawned, latest status each. */
  const [agents, setAgents] = createSignal<AgentEntry[]>([])
  /** Key of the subagent whose conversation fills the center, or undefined (main). */
  const [agentView, setAgentView] = createSignal<string | undefined>(undefined)
  const [agentMessages, setAgentMessages] = createSignal<Message[]>([])
  /**
   * Every foreground command this session ran (bash calls), with its output
   * — live while it runs. Background tasks come from the registry instead.
   */
  const [fgShells, setFgShells] = createSignal<(ShellView & { output: string })[]>([])
  const runningShellCount = () => fgShells().filter((shell) => shell.status === "running").length
  /** Id of the shell whose output fills the center, or undefined. */
  const [shellView, setShellView] = createSignal<string | undefined>(undefined)
  /** Polled log tail of the viewed background shell. */
  const [bgShellOutput, setBgShellOutput] = createSignal("")
  const updateFgShell = (id: string, patch: Partial<ShellView & { output: string }>) => {
    const current = fgShells()
    const at = current.findIndex((shell) => shell.id === id)
    if (at < 0) return false
    setFgShells(current.map((shell, i) => (i === at ? { ...shell, ...patch } : shell)))
    return true
  }
  const [changedFiles, setChangedFiles] = createSignal<string[]>([])
  const [sessionUsage, setSessionUsage] = createSignal<Usage>({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  })
  const [sidebarPref, setSidebarPref] = createSignal<SidebarPref>("auto")
  /** Ctrl+T: the narrow strip shows the whole plan instead of one line. */
  const [planExpanded, setPlanExpanded] = createSignal(false)
  /** Ctrl+X leader chord: the next key is a panel command until this time. */
  let leaderUntil = 0
  /** What the center pane shows: the main conversation or the opened subagent's. */
  const displayed = () => {
    if (agentView() !== undefined) return agentMessages()
    // The sidebar shows live agent status, so progress lines would repeat it.
    return layout().sidebar ? messages().filter((m) => m.progressId === undefined) : messages()
  }

  const loadAgentMessages = (agent: AgentEntry | undefined) => {
    if (!agent?.journalPath) {
      setAgentMessages([{ kind: "info", text: "waiting for this agent to start..." }])
      return
    }
    try {
      const { header, events } = SessionJournal.replay(agent.journalPath)
      const restored = timelineToMessages(project(header, events).timeline)
      setAgentMessages(restored.length > 0 ? restored : [{ kind: "info", text: "starting..." }])
    } catch {
      setAgentMessages([{ kind: "info", text: "waiting for this agent to start..." }])
    }
  }
  const upsertAgent = (callId: string, update: SubagentUpdate) => {
    const key = `${callId}:${update.id}`
    const entry: AgentEntry = { ...update, key, callId, updatedAt: Date.now() }
    const current = agents()
    const at = current.findIndex((a) => a.key === key)
    const next =
      at >= 0 ? current.map((a, i) => (i === at ? entry : a)) : [...current, entry].slice(-30)
    setAgents(next)
    if (agentView() === key) loadAgentMessages(entry)
  }
  createEffect(() => {
    if (agentView() !== undefined) setShellView(undefined)
  })
  /** Alt+Right / Alt+Left: main -> agent 1 -> ... -> agent n -> main. */
  const cycleAgentView = (step: 1 | -1) => {
    const keys = [undefined, ...agents().map((a) => a.key)]
    if (keys.length === 1) return
    const at = keys.indexOf(agentView())
    const nextKey = keys[(at + step + keys.length) % keys.length]
    setAgentView(nextKey)
    if (nextKey !== undefined) loadAgentMessages(agents().find((a) => a.key === nextKey))
  }
  const notePanelResult = (meta: unknown) => {
    const todos = metaTodos(meta)?.todos
    if (todos) setPlanTodos(todos)
    const path = metaDiff(meta)?.path
    if (path && !changedFiles().includes(path)) setChangedFiles([...changedFiles(), path])
  }
  /** Rebuild the panels from the journal (resume, rewind, undo, new). */
  const syncPanels = () => {
    setAgents([])
    setAgentView(undefined)
    setFgShells([])
    setShellView(undefined)
    try {
      const { header, events } = SessionJournal.replay(session.journal.path)
      const timeline = project(header, events).timeline
      setPlanTodos(todosFromTimeline(timeline) ?? [])
      const files: string[] = []
      const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      for (const event of timeline) {
        if (event.type === "tool.result" && !event.isError) {
          const path = metaDiff(event.meta)?.path
          if (path && !files.includes(path)) files.push(path)
        }
      }
      for (const event of events) {
        if (event.type !== "turn.completed") continue
        usage.input += event.usage.input
        usage.output += event.usage.output
        usage.cacheRead += event.usage.cacheRead
      }
      setChangedFiles(files)
      setSessionUsage(usage)
    } catch {
      setPlanTodos([])
      setChangedFiles([])
    }
  }
  /** Ctrl+R: expands thinking text for every visible thinking block.
   * View-state only; thinking blocks are not replayed on /resume. */
  const [thinkingExpanded, setThinkingExpanded] = createSignal(false)
  /**
   * Only the latest todo result renders as a card; earlier ones show their
   * terse line. Derived from `messages()` so it can never drift.
   */
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
  /** Transient status-bar line: live timer, settled turn marker, copy notice. */
  const [status, setStatus] = createSignal("")
  /**
   * The last turn's marker only. Kept separate from `status()` so /status's
   * `last turn` row isn't overwritten by other notices. Cleared with the turn
   * history it describes (/new, /resume, /undo, /rewind), never fabricated on replay.
   */
  const [lastTurnMarker, setLastTurnMarker] = createSignal("")
  /** Clears both turn signals together. */
  const resetTurnStatus = () => {
    setStatus("")
    setLastTurnMarker("")
    // Callers just swapped or rewound the timeline; the panels follow it.
    syncPanels()
  }

  /**
   * Mouse select-to-copy. OpenTUI enables mouse tracking and selectable text
   * by default, and the "selection" event fires once per selection end (not
   * per drag frame); wheel scrolling uses a separate path, so this doesn't
   * fight the scrollboxes. One renderer-level handler covers every screen.
   * Copies through OpenTUI's capability-aware OSC 52 API; we only apply the
   * size cap first (see clipboard.ts).
   */
  let osc52UnsupportedNotified = false
  useSelectionHandler((selection) => {
    const text = selection.getSelectedText()
    // A click with no drag yields an empty selection; skip it silently.
    if (!text) return
    if (!renderer.isOsc52Supported()) {
      // Tell the user once per session, on a real copy attempt, so they don't
      // assume the selection reached the clipboard.
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
      // best-effort; a failed clipboard write must never interrupt the UI
      return
    }
    // false means the bytes did not go out; never claim "copied" then.
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
    /** Optional caution under the title that qualifies the whole list (e.g.
     * "ids came from the offline catalog"). Kept off the title so it never
     * crowds the keybinding hints. */
    note?: string
    items: { label: string; value: string }[]
    index: number
    filter: string
    onPick: (value: string) => void
  } | null>(null)
  /**
   * `/provider`'s key-entry step. Its own signal rather than a SetupStage:
   * setup replaces the transcript pane and types the model id, while
   * /provider runs mid-session, keeps the transcript visible like other
   * overlays, and ends on the model picker.
   */
  const [providerKeyStep, setProviderKeyStep] = createSignal<{
    provider: string
    hasExisting: boolean
  } | null>(null)
  const [cmdIndex, setCmdIndex] = createSignal(0)
  const [planMode, setPlanMode] = createSignal(false)
  const [queued, setQueued] = createSignal<string[]>([])
  const [history, setHistory] = createSignal<string[]>([])
  let historyPos = -1
  /** Pending image chips, consumed and cleared on the next submit(). */
  const [attachedImages, setAttachedImages] = createSignal<{ path: string; mediaType: string }[]>(
    [],
  )
  /**
   * Pending paste-chip payloads keyed by chip number. The draft holds only the
   * `[Pasted #N +K lines]` label; submit() expands it and clears this map.
   */
  const [pasteChips, setPasteChips] = createSignal<ReadonlyMap<number, string>>(new Map())
  /** Monotonic; never reused, even after a chip is deleted. */
  let nextChipNumber = 1
  /**
   * The composer `<input>`, needed for the cursor position: chip-backspace
   * only fires when the cursor is at the end of the draft, so editing earlier
   * text never deletes a chip. `cursorOffset` is in UTF-16 code units, so it
   * compares directly to `draft().length`.
   */
  let composerRef: InputRenderable | undefined

  // Transcript pager (Ctrl+O): full-screen modal over the raw journal export
  // (no compaction/prune fold), so search reaches turns `messages()` no longer
  // shows. `pagerLine` is the shared cursor for n/N and `{`/`}` navigation.
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
  // /loop run: live card state plus its own abort handle, separate from
  // `abort` so Ctrl+C can say "loop interrupted" vs "turn interrupted". Both
  // are aborted on Ctrl+C; busy() guarantees they never run at once.
  const [loopCard, setLoopCard] = createSignal<LoopCardState | null>(null)
  let loopAbort: AbortController | undefined

  const cmdList = (): SlashCommand[] =>
    !setup() && !picker() && !busy() && !providerKeyStep() ? commandMatches(draft()) : []

  // Braille spinner. Only ticks while busy, so an idle TUI does no re-render work.
  const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  const [spin, setSpin] = createSignal(0)
  const spinTimer = setInterval(() => {
    if (busy()) setSpin((s) => (s + 1) % SPINNER.length)
  }, 80)
  onCleanup(() => clearInterval(spinTimer))

  /**
   * Per-turn elapsed timer. `turnStartedAt` is set before each setBusy(true)
   * and read at completion for the `· 1m 23s` marker; never journaled, so a
   * replayed turn never shows a fabricated duration. `elapsedTick` only
   * forces the live line to re-render each second while busy.
   */
  const [turnStartedAt, setTurnStartedAt] = createSignal<number | undefined>(undefined)
  const [elapsedTick, setElapsedTick] = createSignal(0)
  const elapsedTimer = setInterval(() => {
    if (busy()) setElapsedTick((t) => t + 1)
  }, 1000)
  onCleanup(() => clearInterval(elapsedTimer))
  /** "12s" for a call started at `startedAt`, re-rendered by the 1s ticker. */
  const runningFor = (startedAt: number): string => {
    elapsedTick()
    return shortElapsed(Date.now() - startedAt)
  }
  const elapsedText = (): string => {
    elapsedTick() // subscribe: re-render once a second while busy
    const start = turnStartedAt()
    return start === undefined ? "" : formatDuration(Date.now() - start)
  }

  const modelRef = () => config().model

  // @-mention frecency store: touched on picker picks and on files the
  // edit/read tools touch.
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
  /** The model's output-token ceiling from the catalog (sent as max_tokens). */
  const outputLimit = () => {
    const ref = modelRef()
    if (!ref) return undefined
    try {
      const parsed = parseModelRef(ref)
      return catalog.lookup(parsed.providerId, parsed.modelId)?.output
    } catch {
      return undefined
    }
  }
  /**
   * Model for summarization-class work (compaction, evolver, commit
   * messages): small_model, else a cheap same-provider companion from the
   * catalog (auto_small_model), else undefined (the main model). Never used
   * for subagents.
   */
  const summaryModel = (ref: string): string | undefined => {
    const explicit = config().small_model
    if (explicit) return explicit
    if (config().auto_small_model === false) return undefined
    try {
      const parsed = parseModelRef(ref)
      const id = catalog.cheapCompanion(parsed.providerId, parsed.modelId)
      return id ? `${parsed.providerId}/${id}` : undefined
    } catch {
      return undefined
    }
  }
  // Only an affirmative catalog match allows sending image bytes; unknown
  // counts as unsupported.
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
  // Background bash tasks: one registry for the session, shared by /tasks,
  // quit()'s reap and the journal. Finished tasks post a plain info line
  // rather than going through the turn-scoped attention module.
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
  /** Context lengths local servers actually serve (ref → tokens), from probes. */
  const servedLimits = new Map<string, number>()
  const refreshCtxLimit = () => {
    const ref = modelRef()
    if (!ref) return
    try {
      const parsed = parseModelRef(ref)
      const catalogLimit = catalog.lookup(parsed.providerId, parsed.modelId)?.context
      const served = servedLimits.get(ref)
      // The smaller wins: a server truncates at what it serves.
      setCtxLimit(
        served !== undefined && (catalogLimit === undefined || served < catalogLimit)
          ? served
          : catalogLimit,
      )
    } catch {
      setCtxLimit(undefined)
    }
  }
  /**
   * Ollama serves models at its own context length (often 4k) and silently
   * truncates longer requests. Probe /api/ps for the served length, use it
   * as the limit (local models have no catalog row), and warn once if it
   * can't hold the prefix plus a working margin.
   */
  const probeServedContext = async (): Promise<void> => {
    const ref = modelRef()
    if (!ref || servedLimits.has(ref)) return
    let parsed: ReturnType<typeof parseModelRef>
    try {
      parsed = parseModelRef(ref)
    } catch {
      return
    }
    if (parsed.providerId !== "ollama") return
    const base =
      config().providers?.["ollama"]?.baseURL ?? presetBaseURL("ollama") ?? OLLAMA_DEFAULT_BASE
    const served = await probeOllamaContext(base, parsed.modelId)
    if (served === undefined || servedLimits.has(ref)) return
    servedLimits.set(ref, served)
    refreshCtxLimit()
    const prefixTokens =
      Math.ceil(frozenSystem(ref).length / 4) +
      Math.ceil(JSON.stringify(registry.list()).length / 4)
    const warning = servedContextWarning(parsed.modelId, served, prefixTokens)
    if (warning) push({ kind: "error", text: warning })
  }
  void ModelsCatalog.load({
    cachePath: join(home, ".config", "butterfly", "models-cache.json"),
  })
    .then((loaded) => {
      catalog = loaded
      refreshCtxLimit()
      void probeServedContext()
    })
    .catch(() => {})

  // Code graph: CodeGraph owns graph.db and .butterfly/project-map.md. The
  // first sync runs in the background; explore re-syncs incrementally
  // (throttled) before each call so it sees recent edits. Settled turns
  // re-sync too.
  let codeGraph: CodeGraph | undefined
  try {
    codeGraph = CodeGraph.open(props.cwd)
  } catch {
    // unwritable .butterfly: explore stays unavailable; grep/read still work
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

  // Memory: frozen snapshots + episodic index + skills.
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
  // Shared subagent options: the "task" tool and /review both spawn through
  // this isolated-journal, read-only registry (runSubagentTurn).
  const taskToolOpts: TaskToolOptions = {
    provider: () => freshProvider(),
    model: () => modelRef() ?? "",
    subagentModel: () => config().subagent_model ?? config().small_model,
    // Subagent spend is priced at its own model and folded into the turn's
    // totals by the runner (meta.spend), so budgets see fan-outs.
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
    // isolation:"worktree": the same set plus edit+bash, rooted at the
    // subagent's disposable worktree. Without it, isolation requests are refused.
    makeMutatingRegistry: () => mutatingSubagentRegistry(subagentExtras),
  }
  registry.register(createTaskTool(taskToolOpts))
  // /loop run: a fresh registry per iteration, the same tool set as
  // cli/loop.ts's makeRegistry. No task/mcp tool, matching the CLI.
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
    // Reap still-running background tasks; keepAlive:true ones are left running.
    bgTasks.reap()
    try {
      renderer.destroy()
    } catch {
      // destroy failed, so nothing else will clear the progress indicator.
      clearTerminalProgress()
      process.exit(0)
    }
  }

  /**
   * No manual scrollTo here: the transcript scrollbox is stickyScroll
   * (bottom) and re-pins after relayout while respecting a manual scroll-up.
   * Scrolling in the same tick as setMessages reads a stale scrollHeight and
   * under-scrolls multi-line pushes.
   */
  const push = (message: Message) => {
    setMessages([...messages(), message])
  }

  // Single approval surface for both permission asks and harness
  // confirmations (e.g. /commit's "stage?" question).
  const showApprovalPrompt = (text: string, quickAdd?: QuickAddOffer): Promise<"allow" | "deny"> =>
    new Promise((resolve) => {
      // Terminal bell: surfaces the prompt when the user has tabbed away.
      process.stdout.write("\x07")
      // Desktop notification alongside the bell, which is easy to miss or mute.
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

  /**
   * A real permission-tree ask (tool/target known). Computes the quick-add
   * rule up front against the same `rules` this turn's registry checks, so
   * the [a] preview is exactly what gets installed. If planQuickAdd refuses,
   * `quickAdd` is omitted and no [a] is offered.
   */
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

  /**
   * Commits an [a]lways-allow rule: installs it in the session's permission
   * tree now (rules are captured per turn, so it applies from the next turn)
   * and best-effort persists it to the project butterfly.jsonc. If the config
   * can't be written, the session rule still applies and a manual-edit
   * snippet is shown.
   */
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

  const appendAssistantNow = (text: string) => {
    const all = messages()
    const last = all.at(-1)
    if (last?.kind === "assistant" && last.live) {
      // Same row, new text: update in place (see Message.live).
      const combined = last.text + text
      last.text = combined
      last.live.set(combined)
      if (last.thinkClosedAt === undefined) {
        const split = splitThink(combined)
        if (split.thinking !== "" && !split.open) {
          // Inline </think> just landed: one object swap to stamp the close.
          const copy = [...all]
          copy[copy.length - 1] = { ...last, thinkClosedAt: Date.now() }
          setMessages(copy)
        }
      }
      return
    }
    // Inline <think> timing uses the same fields as native thinking messages.
    // thinkClosedAt is set once splitThink reports the block closed
    // (including a block delivered in one delta).
    const split = splitThink(text)
    const [liveText, setLiveText] = createSignal(text)
    const created: Message = {
      kind: "assistant",
      text,
      live: { text: liveText, set: setLiveText },
      thinkStartedAt: Date.now(),
      ...(split.thinking !== "" && !split.open ? { thinkClosedAt: Date.now() } : {}),
    }
    setMessages([...all, created])
    // No manual scrollTo; see push().
  }

  // @-mention picker. Candidates come from the graph DB, falling back to a
  // glob walk while the graph syncs; ranked by frecency. Picking inserts
  // `@relative/path ` (quoted if it has spaces) and bumps its frecency.
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
    // The markdown element's headings/bold/list text stay invisible until the
    // worker-backed highlighter catches up, which on a long journal looks
    // broken. Show a notice, cleared after a short window unless replaced.
    setPagerNotice("rendering…")
    setPagerOpen(true)
    setTimeout(() => {
      setPagerNotice((current) => (current === "rendering…" ? "" : current))
    }, 500)
  }
  const closePager = () => setPagerOpen(false)

  /** Incremental search: recomputes matches per keystroke and jumps to the
   * first match at or after the current position. */
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

  /** Writes the full session export to a scratch file: the first step for
   * both `[` and `v`, and the fallback if either's best-effort part fails. */
  const writePagerExport = (): string => {
    const id = session.journal.header.sessionId.slice(0, 8)
    // One file per session under <temp>/butterfly/pager, overwritten on each
    // export.
    const dir = join(tmpdir(), "butterfly", "pager")
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${id}.md`)
    writeFileSync(file, pagerDoc().source)
    return file
  }

  /**
   * `[`: best-effort dump into native terminal scrollback. While suspended the
   * terminal is back on the main screen buffer, so a raw stdout write lands in
   * real scrollback. OpenTUI has no simpler API for this; the file written
   * above is the fallback.
   */
  const pagerDumpScrollback = () => {
    const file = writePagerExport()
    // suspend() and resume() are paired in a finally: once suspended, raw mode
    // is off and the render loop paused, so a throw in between would leave the
    // TUI dead. `suspended` keeps a failed suspend() from being "resumed".
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
          // best-effort; nothing more to do if resume fails
        }
      }
    }
  }

  /** `v`: export and hand the terminal to $EDITOR/$VISUAL (suspend, spawn
   * with inherited stdio, resume). Without an editor, or on failure, just
   * reports the file path. */
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
        // best-effort; nothing more to do if resume fails
      }
    }
  }

  /**
   * Set when a provider "error" event is rendered as a card. The runner emits
   * the event before throwing, so this flips before submit()'s `.catch` runs,
   * letting it avoid rendering the same error twice.
   */
  let providerErrorRendered = false

  /**
   * Index into `messages()` where the current provider step's live output
   * starts. A `step-retracted` event truncates back to here: a failed
   * attempt's streamed text and tool-call cards were never journaled and
   * would otherwise linger above the retry's output.
   * Advanced only past settled output: the turn's user message, every tool
   * result (already journaled), and every notice (so a "retrying" line
   * survives the next retraction).
   */
  let stepAnchor = 0

  /** Appends a reasoning chunk to the current thinking block, starting a new
   * one if the last message isn't an open thinking block. */
  const appendReasoningNow = (text: string) => {
    const all = messages()
    const last = all.at(-1)
    if (last?.kind === "thinking" && last.thinkClosedAt === undefined && last.live) {
      last.text += text
      last.live.set(last.text)
      return
    }
    const [liveText, setLiveText] = createSignal(text)
    setMessages([
      ...all,
      {
        kind: "thinking",
        text,
        live: { text: liveText, set: setLiveText },
        thinkStartedAt: Date.now(),
      },
    ])
    // No manual scrollTo; see push().
  }

  /**
   * Delta coalescing: deltas collect here and flush once per frame (~16ms).
   * Every non-delta event flushes first, so ordering matches the stream.
   */
  let pendingDelta: { kind: "text" | "reasoning"; text: string } | undefined
  let deltaTimer: ReturnType<typeof setTimeout> | undefined
  const flushDeltas = () => {
    if (deltaTimer !== undefined) {
      clearTimeout(deltaTimer)
      deltaTimer = undefined
    }
    const pending = pendingDelta
    pendingDelta = undefined
    if (!pending) return
    if (pending.kind === "text") appendAssistantNow(pending.text)
    else appendReasoningNow(pending.text)
  }
  const queueDelta = (kind: "text" | "reasoning", text: string) => {
    if (pendingDelta && pendingDelta.kind !== kind) flushDeltas()
    pendingDelta = pendingDelta ? { kind, text: pendingDelta.text + text } : { kind, text }
    deltaTimer ??= setTimeout(flushDeltas, flushDelayMs())
  }
  /**
   * The markdown element re-parses its trailing block on every update, and a
   * long list or paragraph is one block, so cost grows with the message.
   * Short replies flush every frame; long ones back off (up to 250ms).
   */
  const flushDelayMs = (): number => {
    const last = messages().at(-1)
    const length = last?.live ? last.text.length : 0
    return Math.min(250, Math.max(16, Math.floor(length / 40)))
  }
  const appendAssistant = (text: string) => queueDelta("text", text)
  const appendReasoning = (text: string) => queueDelta("reasoning", text)

  /**
   * Freezes every thinking block still open in the current turn (native or
   * unterminated inline <think>) when it is done: answer text starts, a step
   * ends without text, an error lands, or the turn settles. The turn's
   * `.finally` calls this too because a Ctrl+C abort closes the stream with
   * neither a finish nor an error.
   * Scans backwards (stopping at this turn's user message) so blocks followed
   * by notices or tool rows still close, without touching earlier turns.
   * Idempotent: with nothing to close, no signal is written.
   */
  /** A native thinking block may be open (reasoning streamed since the last close). */
  let reasoningOpen = false
  const finalizeOpenThinking = () => {
    // Flush queued deltas before closing blocks, or a late flush could open
    // a new thinking block after the turn settled.
    flushDeltas()
    reasoningOpen = false
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
    if (event.type !== "text-delta" && event.type !== "reasoning-delta") flushDeltas()
    switch (event.type) {
      case "reasoning-delta":
        reasoningOpen = true
        appendReasoning(event.text)
        break
      case "text-delta":
        // Only the first answer delta after reasoning has a block to close;
        // finalizing per delta would flush and copy the list every token.
        if (reasoningOpen) finalizeOpenThinking()
        appendAssistant(event.text)
        break
      case "tool-input-start":
        // The model is still streaming this call's arguments; show it so a
        // big edit never looks like a hang.
        finalizeOpenThinking()
        push({ kind: "info", text: `  preparing ${event.name}...`, progressId: event.callId })
        break
      case "tool-call": {
        finalizeOpenThinking()
        const live = messages()
        if (live.some((m) => m.progressId === event.callId)) {
          setMessages(live.filter((m) => m.progressId !== event.callId))
        }
        push({
          ...toolCallMessage(event.name, event.input, event.callId),
          pending: true,
          startedAt: Date.now(),
        })
        const input = event.input as { command?: unknown; background?: unknown } | undefined
        if (event.name === "bash" && input?.background !== true) {
          setFgShells(
            [
              ...fgShells(),
              {
                kind: "fg" as const,
                id: event.callId,
                command: typeof input?.command === "string" ? input.command : "",
                status: "running" as const,
                startedAt: Date.now(),
                output: "",
              },
            ].slice(-50),
          )
        }
        break
      }
      case "tool-progress": {
        // Live command output: kept for the shell view, with its last lines
        // shown under the command's row.
        if (updateFgShell(event.callId, { output: event.text })) {
          setMessages(
            messages().map((m) =>
              m.isCall && m.callId === event.callId ? { ...m, liveOutput: event.text } : m,
            ),
          )
          break
        }
        // One live line per running subagent call, updated in place (never
        // journaled).
        const all = [...messages()]
        const line: Message = {
          kind: "info",
          text: event.text
            .split("\n")
            .map((row) => `  ${row}`)
            .join("\n"),
          progressId: event.callId,
        }
        const at = all.findIndex((m) => m.progressId === event.callId)
        if (at >= 0) all[at] = line
        else all.push(line)
        setMessages(all)
        break
      }
      case "tool-result": {
        const exitCode = metaBash(event.meta)?.exitCode
        updateFgShell(event.callId, {
          output: event.output,
          status:
            exitCode === undefined || event.output.includes("stopped by the user")
              ? "killed"
              : "exited",
          ...(exitCode !== undefined ? { exitCode } : {}),
        })
        const live = messages().filter((m) => m.progressId !== event.callId)
        setMessages(applyToolResult(live, event.callId, event.output, event.isError, event.meta))
        stepAnchor = messages().length
        notePanelResult(event.meta)
        break
      }
      case "subagent":
        upsertAgent(event.callId, event.update)
        break
      case "step-retracted": {
        // Drop everything the failed attempt streamed (see stepAnchor).
        const settled = messages().slice(0, stepAnchor)
        if (settled.length !== messages().length) setMessages(settled)
        break
      }
      case "finish":
        // Usage panel: count each step as it lands, not only at turn end.
        setSessionUsage((u) => ({
          input: u.input + event.usage.input,
          output: u.output + event.usage.output,
          cacheRead: u.cacheRead + event.usage.cacheRead,
          cacheWrite: u.cacheWrite + event.usage.cacheWrite,
        }))
        finalizeOpenThinking()
        // Live context gauge: the last step's input+output IS the window size.
        setCtxUsed(event.usage.input + event.usage.output)
        break
      case "error": {
        // Errors often land mid-reasoning and the runner throws without a
        // finish, so close the block here or it would stream forever.
        finalizeOpenThinking()
        // Render the structured `info` when the adapter supplied one;
        // otherwise errorInfo stays unset and the plain `text` is shown.
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

  /**
   * `live` says which source answered and callers must keep it:
   * fetchProviderModels fails soft, so a 401 from a bad key looks like being
   * offline and the catalog fallback would hide it. /provider surfaces the
   * flag; text-only callers ignore it.
   */
  const modelListItems = async (
    providerId: string,
    apiKey?: string,
  ): Promise<{ models: { id: string; context?: number; name?: string }[]; live: boolean }> => {
    const providerConfig = config().providers?.[providerId]
    // Live listing from the provider...
    const live = await fetchProviderModels(providerId, {
      apiKey: apiKey ?? providerConfig?.apiKey ?? presetKeyFromEnv(providerId),
      baseURL: providerConfig?.baseURL ?? presetBaseURL(providerId),
    })
    if (live.length > 0) return { models: live, live: true }
    // ...falling back to the offline models.dev snapshot.
    return { models: catalog.listModels(providerId), live: false }
  }

  const modelLabel = (m: { id: string; context?: number; name?: string }): string =>
    `${m.id}${m.context ? `  (${Math.round(m.context / 1000)}k ctx)` : ""}${m.name && m.name !== m.id ? `  — ${m.name}` : ""}`

  /** Shared "nothing came back" wording for /model and /provider when both
   * the live fetch and the catalog are empty. */
  const noModelsNote = (providerId: string): string =>
    providerId === "ollama"
      ? "no local ollama models found (is the server running? `ollama pull <model>` to add one)"
      : `no model list available for "${providerId}" (offline or bad key?) — you can still type any model id`

  /**
   * The catalog-fallback caution. A note, not a blocker: being offline with a
   * good key is normal. Wording depends on `needsKey` (ollama/lmstudio have no key).
   */
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

  /**
   * /provider's final step: one saveGlobalConfig write with the model, plus
   * providers.<id>.apiKey only when a new key was entered (`newKey` is
   * undefined otherwise). saveGlobalConfig deep-merges `providers`, so other
   * providers' keys survive.
   */
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
      // The picker's note is gone by now, so repeat the caution: otherwise a
      // key that just 401'd looks like one that worked.
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

  /** /provider's model step: live listing in the shared picker. An empty list
   * shows the same text note as /model instead of an empty picker. */
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
      // Catalog rows look like live ones, so the note has to sit on the list.
      ...(live ? {} : { note: catalogFallbackNote(provider) }),
      items: models.map((m) => ({ label: modelLabel(m), value: m.id })),
      index: 0,
      filter: "",
      onPick: (value) => applyProviderSelection(provider, value, newKey, !live),
    })
  }

  /** /provider's key step: blank keeps the saved key (undefined falls back to
   * the stored key); any other text replaces it. */
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
      // Per-call checkpoints sit after their step's whole tool.call batch;
      // truncating there would leave a tool.call with no tool.result, which
      // providers reject. safeRewindIndex walks back to the step's start.
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
          model: summaryModel(ref) ?? ref,
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
      // Prompt-cache hit rate over the session, from turn.completed usage.
      const cacheLine = (): string => {
        const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        for (const event of SessionJournal.replay(session.journal.path).events) {
          if (event.type !== "turn.completed") continue
          total.input += event.usage.input
          total.cacheRead += event.usage.cacheRead
        }
        const rate = cacheHitRate(total)
        return rate === undefined
          ? "no turns yet"
          : `${Math.round(rate * 100)}% of ${total.input.toLocaleString()} prompt tokens served from cache`
      }
      const limit = ctxLimit()
      const used = ctxUsed()
      const pct = limit ? Math.round((used / limit) * 100) : undefined
      return [
        `model      ${modelRef() ?? "not configured"}`,
        `context    ${used.toLocaleString()} used${limit ? ` / ${limit.toLocaleString()} (${pct}%)` : " (limit unknown)"}`,
        `thinking   ${reasoning() ?? "provider default"}`,
        `cache      ${cacheLine()}`,
        `spend      ${formatUSD(sessionCost())} this session${config().maxSpendUSD !== undefined ? ` (cap $${config().maxSpendUSD?.toFixed(2)}/turn)` : ""}`,
        `small      ${config().small_model ?? (summaryModel(modelRef() ?? "") ? `${summaryModel(modelRef() ?? "")} (auto — cheapest-tier same-provider model, for summaries)` : "not set")}`,
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
        // Same disclosure as /provider: /model hits the same fallback when
        // the stored key stops working.
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
      // Every mount creates a journal, so drop never-used "(empty session)"
      // rows, except the current one (it needs a row for "(current)").
      // `lastListing` is this same filtered array, so /resume <n> matches.
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
    toggleSidebar: () => {
      setSidebarPref(layout().sidebar ? "off" : "on")
    },
    shells: (arg) => {
      const list = shells()
      const [verb, rest] = arg.split(/\s+/, 2)
      const pick = (n: string | undefined) =>
        n && /^\d+$/.test(n) ? list[Number(n) - 1] : undefined
      if (verb === "main" || verb === "close") {
        openShell(undefined)
        return
      }
      if (verb === "stop" || verb === "kill") {
        const target = rest ? pick(rest) : viewedShell()
        if (rest && !target) {
          push({ kind: "error", text: `no shell ${rest} — /shells lists them` })
          return
        }
        stopShell(target)
        return
      }
      if (verb && /^\d+$/.test(verb)) {
        const target = pick(verb)
        if (!target) {
          push({ kind: "error", text: `no shell ${verb} — /shells lists them` })
          return
        }
        openShell(target.id)
        return
      }
      if (list.length === 0) {
        push({ kind: "info", text: "no shells yet this session" })
        return
      }
      const now = Date.now()
      push({
        kind: "info",
        text: [
          "shells this session:",
          ...list.map((shell, i) => `  ${shellRow(shell, i + 1, now, 72)}`),
          "",
          "/shells N opens one's output · /shells stop N stops it · Esc back",
        ].join("\n"),
      })
    },
    agents: (arg) => {
      const list = agents()
      if (arg === "main") {
        setAgentView(undefined)
        return
      }
      if (/^\d+$/.test(arg)) {
        const target = list[Number(arg) - 1]
        if (!target) {
          push({ kind: "error", text: `no agent ${arg} — /agents lists them` })
          return
        }
        setAgentView(target.key)
        loadAgentMessages(target)
        return
      }
      push({
        kind: "info",
        text:
          list.length === 0
            ? "no parallel agents yet this session"
            : `agents (Alt+Left/Right or /agents N to open, Esc back):\n${list
                .map(
                  (a, i) =>
                    `  ${i + 1}  ${a.phase.padEnd(7)} ${a.steps} steps  ${a.task.replace(/\s+/g, " ").slice(0, 70)}`,
                )
                .join("\n")}`,
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
      // Abbreviate paths here rather than in renderDoctorReport, which the
      // headless `butterfly doctor` also uses and should print in full.
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
        // Most recent matching run wins; the journal is append-only.
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
        // Text-only: the planner returns a JSON array and uses no tools
        // (mirrors cli/loop.ts's "plan" case).
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
      // Mutating (edits files, commits), so denied in plan mode rather than
      // asked. /loop plan stays available: it only stages queue rows.
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
      // A loop run holds `busy` like a chat turn: typed input queues, and
      // once the loop stops drainQueue() runs it as ordinary turns.
      setBusy(true)
      setTurnStartedAt(Date.now())
      // Armed before the preflight await: Ctrl+C only interrupts when
      // `busy() && (abort || loopAbort)`, otherwise it would quit the app.
      loopAbort = new AbortController()
      // Refuse to run on a dirty tree (same check as cli/loop.ts): every
      // green gate ends in `git add -A && git commit`, which would sweep the
      // user's uncommitted work into a loop commit. `--allow-dirty` opts out.
      // setBusy(true) runs first so input typed during this await queues.
      // Fails open: only a git that reports dirt refuses.
      const gitStatus = await runCommand("git status --porcelain", {
        cwd: props.cwd,
        timeoutMs: GIT_STATUS_TIMEOUT_MS,
      })
      const dirty =
        gitStatus.exitCode === 0 && !gitStatus.timedOut ? dirtyLoopLines(gitStatus.stdout) : []
      // Shared exit for "the loop never started": clear busy, disarm the
      // interrupt handle and drain anything queued during the preflight.
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
      // Ctrl+C during the preflight already printed "(loop interrupted...)".
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
      // Loop spend: progress.usage is cumulative, so each event credits only
      // the delta into sessionCost; the $ figure moves during the run and a
      // loop that throws still accounts for what it spent. modelCost() is
      // read per event so a catalog that loads mid-loop prices the rest.
      let loopCredited = 0
      const creditLoopSpend = (usage: Usage) => {
        const credit = loopSpendCredit(usage, modelCost(), loopCredited)
        loopCredited = credit.credited
        if (credit.delta > 0) setSessionCost((c) => c + credit.delta)
      }
      const cap = config().maxSpendUSD
      if (cap !== undefined) push({ kind: "info", text: spendCapNotice(cap) })
      // Unattended runs must not hit "ask" rules (see LOOP_TUI_RULES).
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
          ...(summaryModel(ref) ? { smallModel: summaryModel(ref) } : {}),
          onEvent: (event: LoopEvent) => {
            if ("progress" in event) creditLoopSpend(event.progress.usage)
            setLoopCard((prev) => applyLoopEvent(prev ?? INITIAL_LOOP_CARD, event))
          },
        })
        // Delta-based, so this only adds what a dropped event missed.
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
        // no handoff yet; nothing has run in this repo
      }
      return lines.join("\n")
    },
    // Theme picker. setTheme switches the live tokens and persists the pin,
    // which also stops auto light/dark detection from overriding it.
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
    // /provider picker. Row markers: (current) for the active model's provider,
    // [key] for a stored apiKey; computed fresh from `config()` on each open.
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
    // `/provider <name>` (exact or unique prefix) and the picker land here:
    // providers needing a key open the key step, others go to the model picker.
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
        // Only turn-start checkpoints (no callId): /undo restores the whole turn.
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
      // Busy for the duration: a review ends in a journal append, so no turn
      // may run concurrently. submit() queues anything typed meanwhile.
      setBusy(true)
      setTurnStartedAt(Date.now())
      try {
        const diffOpts = parseReviewArg(arg)
        const result = await runReview(props.cwd, taskToolOpts, diffOpts)
        // Refused before git and the model: a user-fixable typo.
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
        // The summary joins the main conversation via the journal: the model
        // sees it next turn and /resume rebuilds the card.
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
          model: summaryModel(ref) ?? ref,
        })
        if (result.failure) {
          // Never offer `git add -u` in a repo git can't read.
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
            model: summaryModel(ref) ?? ref,
          })
          if (result.nothingStaged) {
            push({ kind: "info", text: "still nothing staged after `git add -u`" })
            return
          }
        }
        push({ kind: "info", text: `commit message:\n\n${result.message}` })
        const path = writeCommitMessageFile(props.cwd, result.message)
        // The commit goes through the normal bash permission flow (staging
        // above has its own y/n), including the [a]lways quick-add.
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
      // The handoff turn ends in journal appends, so no other turn may run
      // concurrently. submit() queues anything typed meanwhile.
      setBusy(true)
      setTurnStartedAt(Date.now())
      try {
        // The handoff turn sends the whole conversation, so meter it like a
        // normal turn and surface the runner's budget notices here.
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
        // The doc is already journaled as message.assistant; mirror it into
        // the live view the way /resume will render it.
        push({ kind: "assistant", text: result.doc })
        push({
          kind: "info",
          // Mentions every route that consumes it, including just restarting
          // butterfly, which the boot-time preload covers.
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

  /**
   * `source` separates the composer's own Enter from internal callers
   * (drainQueue, /init) that pass text the user never typed into the box.
   * Only composer submits run the dropped-chip check below.
   */
  const submit = (value: string, source: "composer" | "internal" = "composer") => {
    if (picker()) return
    const rawTask = value.trim()
    // /provider's key step is the one place a blank Enter means something
    // ("keep the saved key"), so handle it before the empty-input bail.
    const keyStep = providerKeyStep()
    if (rawTask === "" && keyStep) {
      handleProviderKeySubmit(keyStep, "")
      return
    }
    if (rawTask === "" || pendingAsk()) return
    // Expand paste chips and newline markers now. Everything downstream
    // (history, transcript, command parsing, the model) sees only this
    // expanded string.
    const task = expandComposerText(rawTask, pasteChips())
    // Chips are matched by label text, so an edited label isn't expanded.
    // That's correct (deleting a chip must work), but say so rather than
    // dropping it silently.
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
      // Never swallow input typed mid-turn: queue it and run it afterwards,
      // in order. Chips are cleared below; numbering stays monotonic.
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
    // /provider's key step: returns before the transcript push below, so
    // the key is never journaled or echoed.
    if (keyStep) {
      handleProviderKeySubmit(keyStep, task)
      return
    }

    // Prompt history (up/down), capped at 100. Stores the expanded text,
    // since chip payloads are cleared and a bare label would dangle.
    setHistory([...history().slice(-99), task])
    historyPos = -1

    let modelTask = task
    // With the suggestion list open, Enter runs the selected command, not
    // the half-typed prefix. A custom command typed by its exact name
    // outranks fuzzy/synonym rows, so discovery aids never hijack a
    // user-defined command.
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

    // Sending always returns the center pane to the main conversation.
    setAgentView(undefined)
    push({ kind: "user", text: task })
    // Sending re-engages bottom-stick even if the view was scrolled up, once
    // layout has measured the new row.
    setTimeout(() => {
      if (scroll && !scroll.isDestroyed) scroll.scrollTo(scroll.scrollHeight)
    }, 0)
    const ref = modelRef()
    if (!ref) {
      push({ kind: "info", text: "No model configured — run /setup first." })
      return
    }

    // Image chips are optimistic; size/count caps are enforced here, once,
    // via context/media.ts.
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

    // @-mentions: attach each file as capped context and boost it in the
    // skeleton ranking like a chat file.
    const mentions = expandMentions(props.cwd, modelTask)
    const mentionBlock = renderMentionBlock(mentions)
    if (mentionBlock !== "") {
      taskText = `${mentionBlock}\n\n${taskText}`
    }
    if (firstTurn) {
      // /handoff preload: a pending `.butterfly/handoff.md` is loaded on the
      // first turn of a new session (including app boot, since quitting
      // after /handoff is the normal flow), then marked consumed. The notice
      // is pushed into the transcript so the injection is visible.
      // `journalPath` guards against re-injecting: if this session already
      // journaled a session.handoff, the file is the one we just wrote and is
      // left for the next session.
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
        // Whole-repo shape first (modules and dependencies), then ranked
        // symbols, so the model starts oriented.
        const overview = moduleOverview(graph)
        const block = [overview, skeleton].filter((part) => part !== "").join("\n\n")
        if (block !== "") {
          taskText = `[repository map — modules + ranked symbols; explore op=map|outline|symbol|deps for more]\n${block}\n\n${taskText}`
        }
      }
    } else if (graph) {
      // Later turns: only the symbols/files this message names, if any (zero
      // tokens otherwise).
      const focused = focusedSkeleton(graph, task)
      if (focused !== "")
        taskText = `${taskText}\n\n[code graph — where the names above live]\n${focused}`
    }
    firstTurn = false
    setBusy(true)
    // Wall-clock start for this turn: used by the completion marker and the
    // live elapsed display.
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
    // Reset per turn so a previous provider error can't suppress messages
    // for an unrelated failure.
    providerErrorRendered = false
    const turnRules = planMode() ? PLAN_RULES : (config().permissions ?? TUI_DEFAULT_RULES)
    // Retraction anchor (see stepAnchor): this turn's live output starts
    // after everything on screen, including the user's message.
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
        ...(limit ? { limits: { context: limit, output: outputLimit() } } : {}),
        // Without limits the runner still sends its own explicit cap, so a
        // provider default (Sarvam's 2048) never truncates replies.
        ...(!limit && outputLimit() ? { maxOutputTokens: outputLimit() } : {}),
        // butterfly.jsonc's `retries` (0 disables); unset uses the runner's default.
        ...(config().retries !== undefined ? { retries: config().retries } : {}),
        ...(config().autoContinue !== undefined ? { autoContinue: config().autoContinue } : {}),
        ...(config().autoApproveReadOnly === false ? { autoApproveReadOnly: false } : {}),
        ...(summaryModel(ref) ? { smallModel: summaryModel(ref) } : {}),
        codeMap: (files) => {
          const db = graphDb()
          return db ? focusedSkeleton(db, files.join(" "), 400) : ""
        },
        ...(costForRef(summaryModel(ref)) ? { smallModelCost: costForRef(summaryModel(ref)) } : {}),
        imageInputSupported: imageInputSupported(),
        ask: (request) => askPermission(request, turnRules),
      },
      taskText,
      turnImages.length > 0 ? { images: turnImages } : undefined,
    )
      .then((outcome) => {
        setSessionCost((c) => c + outcome.costUSD)
        // Main-model steps were counted live (onEvent "finish"); add the
        // subagent and compaction spend that only the outcome knows.
        setSessionUsage((u) => ({
          input: u.input + outcome.delegatedUsage.input,
          output: u.output + outcome.delegatedUsage.output,
          cacheRead: u.cacheRead + outcome.delegatedUsage.cacheRead,
          cacheWrite: u.cacheWrite + outcome.delegatedUsage.cacheWrite,
        }))
        void probeServedContext()
        // Humanized token counts, suffixed with the turn's wall-clock duration.
        const start = turnStartedAt()
        const marker = turnMarker(outcome.usage, outcome.steps, Date.now() - (start ?? Date.now()))
        // The status bar shows the freshest line; /status reads the marker.
        setStatus(marker)
        setLastTurnMarker(marker)
        // Claimed vs verified (session/verify.ts): did a check run after the
        // last edit, and how did it end? Read off the journal.
        const verification = describeVerification(
          verifyLatestTurn(SessionJournal.replay(session.journal.path).events),
        )
        if (verification !== "") push({ kind: "info", text: verification })
        void (async () => {
          try {
            episodic.indexJournal(session.journal.path)
          } catch {
            // non-fatal
          }
          // Keep graph.db + project-map.md in step with what this turn edited.
          await codeGraph?.sync().catch(() => {})
          graph = graphDb()
          // Self-evolution: durable facts go to memory, recurring procedures
          // to skills. Uses small_model if configured, else the turn's model;
          // the evolver skips turns with nothing to learn.
          if (config().memory?.autoReview !== false) {
            const evolved = await evolveAfterTurn({
              provider: freshProvider(),
              model: summaryModel(ref) ?? ref,
              journal: session.journal,
              paths,
              skillDir: skillDirs[0] as string,
              skillDirs,
              autoSkills: config().memory?.autoSkills !== false,
              approval: config().memory?.approval === true,
            })
            // Evolver calls are real spend; count them in the session $ meter.
            const evolverCost = costForRef(summaryModel(ref) ?? ref)
            if (evolverCost) setSessionCost((c) => c + computeCostUSD(evolved.usage, evolverCost))
            const line = describeEvolution(evolved)
            if (line !== "") push({ kind: "info", text: line })
          }
        })()
      })
      .catch((error: unknown) => {
        turnDetail = error instanceof Error ? error.message : String(error)
        // The error event already rendered a structured card for this
        // rejection (see providerErrorRendered); don't show it twice.
        if (!providerErrorRendered) {
          push({
            kind: "error",
            text: `Error: ${turnDetail}`,
          })
        }
      })
      .finally(() => {
        // Backstop for abnormal ends with no in-stream close signal: Ctrl+C
        // aborts cleanly with no finish or error, and throws outside the
        // provider loop (hooks, assemble()) skip them too. Idempotent.
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

  /**
   * Paste chips, primary path: OpenTUI's bracketed-paste event. Global paste
   * listeners run before the composer's own handling, so preventDefault()
   * keeps the raw text out of the input buffer.
   * A pasted image path is checked first (against draft + paste) and left
   * unprevented so the image-chip flow handles it. Otherwise, text that
   * clears the chip threshold becomes a chip.
   * Not gated on busy() or pendingAsk(): the composer strips newlines, so an
   * unchipped multi-line paste would be queued with its lines fused, and
   * during an approval the composer is still focused and would receive the
   * paste. Gated during setup and /provider's key step (raw key text needed)
   * and while a picker or pager has the keyboard (the composer is unfocused).
   */
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
    /**
     * Ctrl+C is global and handled before every modal branch, so interrupt
     * and quit work from anywhere (pager, picker, approval).
     * A pending approval is resolved as "deny": the runner awaits ctx.ask(),
     * and aborting the signal alone would leave the turn parked on it.
     * Open modals stay open; closing the pager mid-read would be unhelpful.
     * Tests: CliRenderer has its own Ctrl+C handler unless `exitOnCtrlC: false`
     * is passed (startTui does; testRender defaults to true).
     * `/loop run` is interrupted here too: `loopAbort` and `abort` are both
     * aborted, and busy() guarantees at most one is live. `loopAbort` being
     * set picks the message wording.
     */
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
    /**
     * Modal overlays (approval prompt, pickers) own the keystroke.
     * Global key listeners run before the focused renderable's handlers, and
     * closing a picker refocuses the composer in time to receive the same
     * keypress (Enter would also submit, "y"/"n" would be typed).
     * preventDefault() stops dispatch to renderables, making overlay and
     * composer mutually exclusive for every picker at once.
     */
    /**
     * ...but the pager outranks the approval prompt. The pager's keymap
     * consumes ordinary typing (`/` search, `n`/`N`), so while it's open no
     * key answers an ask; otherwise a search keystroke could approve a tool
     * or persist an [a]lways rule. The ask box stays visible below the pager
     * and says how to reach it (Esc closes the pager).
     */
    const ask = pendingAsk()
    if (ask && !pagerOpen()) {
      key.preventDefault()
      if (key.name === "y") ask.resolve("allow")
      if (key.name === "n" || key.name === "escape") ask.resolve("deny")
      // Quick-add: only offered when the ask carries a computed rule. Applies
      // the rule, then allows the current call.
      if (key.name === "a" && ask.quickAdd) {
        applyQuickAdd(ask.quickAdd)
        ask.resolve("allow")
      }
      return
    }
    // Transcript pager (Ctrl+O): toggled from anywhere except onboarding,
    // never stacked on another modal. Same preventDefault gate as above.
    if (key.ctrl && key.name === "o" && !setup() && !providerKeyStep()) {
      key.preventDefault()
      if (pagerOpen()) closePager()
      else if (!picker()) openPager()
      return
    }
    /**
     * Ctrl+R: toggles full thinking text for collapsed thinking blocks. Not
     * during onboarding or while the pager owns the keyboard. View-state only.
     */
    // Multi-pane keys (no Ctrl+B, the tmux prefix). Ctrl+X is a leader: then
    // B toggles the sidebar, A opens the next agent, 0-9 jumps to main or
    // agent N. Alt+Left/Right walk main <-> agents; Esc returns to main;
    // Ctrl+T toggles the pinned plan. None fire over pickers, approvals, the
    // pager or onboarding.
    const panelKeysLive =
      !setup() && !providerKeyStep() && !pagerOpen() && !picker() && !pendingAsk()
    if (panelKeysLive && leaderUntil > Date.now()) {
      leaderUntil = 0
      const name = (key.name ?? "").toLowerCase()
      if (name === "b") {
        key.preventDefault()
        setSidebarPref(layout().sidebar ? "off" : "on")
        return
      }
      if (name === "a" || name === "down") {
        key.preventDefault()
        cycleAgentView(1)
        return
      }
      if (name === "s") {
        key.preventDefault()
        toggleShellView()
        return
      }
      if (name === "k") {
        key.preventDefault()
        stopShell(viewedShell())
        return
      }
      if (/^[0-9]$/.test(name)) {
        key.preventDefault()
        const n = Number(name)
        const target = n === 0 ? undefined : agents()[n - 1]
        setAgentView(target?.key)
        if (target) loadAgentMessages(target)
        return
      }
    }
    if (panelKeysLive && key.ctrl && key.name === "x") {
      key.preventDefault()
      leaderUntil = Date.now() + 1500
      return
    }
    if (panelKeysLive && key.meta && (key.name === "left" || key.name === "right")) {
      key.preventDefault()
      if (shellView() !== undefined) cycleShellView(key.name === "right" ? 1 : -1)
      else cycleAgentView(key.name === "right" ? 1 : -1)
      return
    }
    if (panelKeysLive && key.ctrl && key.name === "t") {
      key.preventDefault()
      setPlanExpanded((expanded) => !expanded)
      return
    }
    if (
      panelKeysLive &&
      key.name === "escape" &&
      (agentView() !== undefined || shellView() !== undefined) &&
      cmdList().length === 0
    ) {
      key.preventDefault()
      setAgentView(undefined)
      setShellView(undefined)
      return
    }
    // Shift+Tab cycles thinking effort for the next turn. Gated like Ctrl+R,
    // and not while a picker, approval or the slash-command list owns the
    // keyboard.
    if (
      key.shift &&
      key.name === "tab" &&
      !setup() &&
      !providerKeyStep() &&
      !pagerOpen() &&
      !picker() &&
      !pendingAsk() &&
      cmdList().length === 0
    ) {
      key.preventDefault()
      setReasoning((current) => nextEffort(current))
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
          // Cancels only the search entry; a second Escape closes the pager.
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
    /**
     * Ctrl+V image paste: best-effort and not preventDefault()'d. Most
     * terminals deliver text pastes as bracketed paste, so an image paste
     * can't be told apart in advance; saveClipboardImage returns null for
     * text, so firing on every Ctrl+V is harmless.
     */
    if (key.ctrl && key.name === "v" && !setup() && !busy() && !providerKeyStep()) {
      void actions.pasteImage()
    }
    /**
     * Multiline input: OpenTUI's `<input>` maps return/linefeed to submit and
     * its value setter strips `/[\n\r]/g`, so a real "\n" can't survive the
     * `draft` signal. NEWLINE_MARKER stands in for line breaks and is expanded
     * at submit (see paste.ts). Both bindings preventDefault so the input
     * doesn't submit.
     */
    if (!setup() && !pagerOpen() && !picker() && !pendingAsk() && !providerKeyStep()) {
      // Ctrl+J: a bare LF parses as { name: "linefeed", sequence: "\n" } under
      // the legacy parser, and as { name: "j", ctrl: true } under the Kitty
      // protocol. Check both.
      if (key.sequence === "\n" || key.name === "linefeed" || (key.ctrl && key.name === "j")) {
        key.preventDefault()
        setDraft(draft() + NEWLINE_MARKER)
        return
      }
      // `\`+Enter: Enter always arrives as "return"/"kpenter", so a trailing
      // backslash in the draft is the signal. Shift+Enter often never reaches
      // the app, so it isn't relied on.
      if ((key.name === "return" || key.name === "kpenter") && draft().endsWith("\\")) {
        key.preventDefault()
        setDraft(`${draft().slice(0, -1)}${NEWLINE_MARKER}`)
        return
      }
      // Atomic chip backspace: Backspace right after a chip label removes the
      // whole label and its payload. Only when the cursor is actually at the
      // end of the draft (via `composerRef`; if unattached, fall back to a
      // normal backspace). An active selection takes priority.
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
    // Input history recall: takes priority while browsing; otherwise only
    // from an empty composer so it never fights the command list.
    // History stores expanded text, so toComposerDraft converts "\n" back to
    // markers (the composer would strip them); recall + Enter then reproduces
    // the entry exactly.
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
          // Complete to the token that matched (name or alias), e.g.
          // `/res` -> `/resume `.
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
    // /provider's key step: Esc cancels the whole flow. Clears draft() too so
    // a partial key doesn't linger (it was never journaled), and pasteChips
    // so no stale payload triggers a "chip no longer in the message" warning
    // on the next submit.
    if (key.name === "escape" && providerKeyStep()) {
      setProviderKeyStep(null)
      setDraft("")
      setPasteChips(new Map())
      push({ kind: "info", text: "provider switch cancelled" })
      return
    }
  })

  const layout = createMemo(
    (previous: LayoutPlan | undefined): LayoutPlan =>
      planLayout(dimensions().width, {
        pref: sidebarPref(),
        hasAgents: agents().length > 0,
        sessionStarted: messages().length > 0,
        ...(previous ? { previous } : {}),
      }),
  )
  const viewedAgent = () => agents().find((a) => a.key === agentView())
  // A running agent's journal grows between status events, so re-read it
  // once a second while shown. Shells: running foreground bash calls plus
  // background tasks from the registry, polled once a second (the signal
  // only changes when a task starts or ends).
  const [bgShells, setBgShells] = createSignal<ShellView[]>([])
  let bgShellsKey = ""
  const bgPoll = setInterval(() => {
    const list: ShellView[] = bgTasks.list().map((task) => ({
      kind: "bg" as const,
      id: task.id,
      command: task.command,
      status: task.status,
      startedAt: Date.parse(task.startedAt),
      ...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
    }))
    const key = list.map((t) => `${t.id}:${t.status}`).join(",")
    if (key !== bgShellsKey) {
      bgShellsKey = key
      setBgShells(list)
    }
    refreshBgShellOutput()
    // Keep running background shells' elapsed times moving while idle too.
    if (!busy() && list.some((t) => t.status === "running")) setElapsedTick((t) => t + 1)
  }, 1000)
  onCleanup(() => clearInterval(bgPoll))
  /** Every shell this session, in start order — ordinals are stable. */
  const shells = (): ShellView[] =>
    [...fgShells(), ...bgShells().slice(-20)].sort((a, b) => a.startedAt - b.startedAt)
  const viewedShell = () => shells().find((shell) => shell.id === shellView())
  const viewedShellOutput = (): string => {
    const shell = viewedShell()
    if (!shell) return ""
    if (shell.kind === "bg") return bgShellOutput()
    return fgShells().find((s) => s.id === shell.id)?.output ?? ""
  }
  const refreshBgShellOutput = () => {
    const shell = viewedShell()
    if (shell?.kind === "bg") setBgShellOutput(bgTasks.tail(shell.id, 20_000) ?? "")
  }
  const openShell = (id: string | undefined) => {
    setShellView(id)
    if (id !== undefined) {
      setAgentView(undefined)
      refreshBgShellOutput()
    }
  }
  /** Ctrl+X S: open the running shell (else the latest); again closes it. */
  const toggleShellView = () => {
    if (shellView() !== undefined) {
      openShell(undefined)
      return
    }
    const list = shells()
    const target = list.filter((s) => s.status === "running").at(-1) ?? list.at(-1)
    if (!target) {
      push({ kind: "info", text: "no shells yet this session" })
      return
    }
    openShell(target.id)
  }
  const cycleShellView = (step: 1 | -1) => {
    const list = shells()
    if (list.length === 0) return
    const at = list.findIndex((s) => s.id === shellView())
    const next = list[(at + step + list.length) % list.length]
    openShell(next?.id)
  }
  const stopShell = (shell: ShellView | undefined) => {
    if (!shell) {
      push({ kind: "info", text: "open a shell first (Ctrl+X S or /shells N)" })
      return
    }
    const ordinal = shells().findIndex((s) => s.id === shell.id) + 1
    if (shell.status !== "running") {
      push({ kind: "info", text: `shell ${ordinal} already finished` })
      return
    }
    const ok = shell.kind === "fg" ? killCommand(shell.id) : bgTasks.kill(shell.id)
    push({
      kind: "info",
      text: ok ? `stopped shell ${ordinal}: ${shell.command}` : `shell ${ordinal} is not running`,
    })
  }
  /** Wall clock for elapsed shell times — ticks once a second while busy. */
  const clock = (): number => {
    elapsedTick()
    return Date.now()
  }

  const agentPoll = setInterval(() => {
    const agent = viewedAgent()
    if (agent && (agent.phase === "running" || agent.phase === "queued")) loadAgentMessages(agent)
  }, 1000)
  onCleanup(() => clearInterval(agentPoll))

  const mark = renderWordmark()
  const markMode = () => wordmarkMode(dimensions().width)
  /**
   * Any overlay that takes the keyboard replaces the big block-pixel mark
   * rather than drawing on top of it, same as having messages.
   */
  const anyOverlayOpen = () =>
    Boolean(picker()) ||
    Boolean(pendingAsk()) ||
    Boolean(providerKeyStep()) ||
    Boolean(loopCard()) ||
    cmdList().length > 0
  const showBigMark = () =>
    messages().length === 0 && !setup() && !anyOverlayOpen() && markMode() !== "plain"
  /** Below ~77 cols `markMode()` is "plain": show the centered two-tone
   * wordmark and tagline instead of an empty screen. */
  const showPlainWelcome = () =>
    messages().length === 0 && !setup() && !anyOverlayOpen() && markMode() === "plain"
  const markRows = () => [0, 1, 2, 3, 4, 5]

  /** Context gauge: `ctx <used>[/<limit>] (<pct>%)`, humanized. */
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

      {/* Multi-pane body: [agents] | conversation | sidebar. */}
      <box flexDirection="row" flexGrow={1} minHeight={0}>
        <Show when={layout().agentsPane && !pagerOpen()}>
          <AgentsPane width={layout().agentsWidth} agents={agents()} selectedKey={agentView()} />
        </Show>
        <box flexGrow={1} minHeight={0} flexDirection="column">
          <Show when={viewedAgent()}>
            {(agent: Accessor<AgentEntry>) => (
              <AgentViewHeader
                agent={agent()}
                ordinal={agents().findIndex((a) => a.key === agent().key) + 1}
                total={agents().length}
              />
            )}
          </Show>
          <Show when={!pagerOpen() && viewedShell()}>
            {(shell: Accessor<ShellView>) => (
              <ShellPane
                shell={shell()}
                ordinal={shells().findIndex((s) => s.id === shell().id) + 1}
                total={shells().length}
                now={clock()}
                output={viewedShellOutput()}
              />
            )}
          </Show>
          <box
            flexGrow={1}
            minHeight={0}
            paddingLeft={2}
            paddingRight={2}
            visible={pagerOpen() || viewedShell() === undefined}
          >
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
                          PROVIDERS.find(
                            (p) => p.id === (setup() as { provider?: string }).provider,
                          )?.example ?? "model-id"
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
                            fg={
                              message.kind === "error" ? themeTokens().error : themeTokens().muted
                            }
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
                  {/* Narrow terminals: centered text wordmark and tagline instead
                      of the big mark. */}
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
                      // Reserve a gutter so the scrollbar never draws over text,
                      // and theme its chrome.
                      viewportOptions={{ paddingRight: 2 }}
                      verticalScrollbarOptions={{
                        trackOptions: {
                          backgroundColor: themeTokens().bg,
                          foregroundColor: themeTokens().border,
                        },
                      }}
                    >
                      <For each={displayed()}>
                        {(message, index) => {
                          // Inline <think> split, assistant messages only.
                          // Reactive on the live channel so a streaming row
                          // updates in place.
                          const inlineThinkMemo =
                            message.kind === "assistant"
                              ? createMemo(() => splitThink(liveText(message)))
                              : undefined
                          const inlineThink = () => inlineThinkMemo?.()
                          return (
                            <Show
                              when={message.kind === "assistant"}
                              fallback={
                                <Show
                                  when={message.kind === "thinking"}
                                  fallback={
                                    <box
                                      marginTop={messageMarginTop(
                                        message,
                                        displayed()[index() - 1],
                                      )}
                                      flexDirection="column"
                                      // Actions sit behind one left rail,
                                      // indented; prose stays flush. (borderStyle
                                      // alone enables a full border, so it is only
                                      // passed to actions.)
                                      {...(message.action
                                        ? {
                                            border: ["left" as const],
                                            borderStyle: "single" as const,
                                            borderColor: themeTokens().border,
                                            paddingLeft: 1,
                                          }
                                        : {})}
                                    >
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
                                                    <box flexDirection="column">
                                                      <ToolCallRow
                                                        text={message.text}
                                                        summary={message.summary}
                                                        failed={message.failed}
                                                        pending={message.pending}
                                                        runningFor={
                                                          message.pending &&
                                                          message.startedAt !== undefined
                                                            ? runningFor(message.startedAt)
                                                            : undefined
                                                        }
                                                      />
                                                      <Show
                                                        when={
                                                          message.pending &&
                                                          liveTail(message.liveOutput) !== ""
                                                        }
                                                      >
                                                        <text fg={themeTokens().muted}>
                                                          {liveTail(message.liveOutput)}
                                                        </text>
                                                      </Show>
                                                    </box>
                                                  </Show>
                                                }
                                              >
                                                {/* Bash command cell: $ header, dim output body,
                                                    right-aligned exit badge. */}
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
                                                      {`${message.exitCode === 0 ? "ok" : `exit ${message.exitCode}`}${message.durationMs !== undefined ? ` · ${shortElapsed(message.durationMs)}` : ""}`}
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
                                            {/* Todo card: only the latest todo result renders as a
                                                card; earlier ones use the terse line above. */}
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
                                        {/* Provider error card: kind-specific headline plus a
                                            capped dim detail (skipped if it repeats the headline). */}
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
                                    thinkingText={liveText(message)}
                                    open={message.thinkClosedAt === undefined}
                                    startedAt={message.thinkStartedAt}
                                    closedAt={message.thinkClosedAt}
                                    expanded={thinkingExpanded()}
                                  />
                                </Show>
                              }
                            >
                              <box flexDirection="column">
                                <Show when={(inlineThink()?.thinking ?? "") !== ""}>
                                  <ThinkingBlock
                                    thinkingText={inlineThink()?.thinking ?? ""}
                                    open={
                                      (inlineThink()?.open ?? false) &&
                                      message.thinkClosedAt === undefined
                                    }
                                    startedAt={message.thinkStartedAt}
                                    closedAt={message.thinkClosedAt}
                                    expanded={thinkingExpanded()}
                                  />
                                </Show>
                                <Show when={(inlineThink()?.rest.trim() ?? "") !== ""}>
                                  <box marginTop={1} flexShrink={0}>
                                    <markdown
                                      content={inlineThink()?.rest.trim() ?? ""}
                                      syntaxStyle={SYNTAX}
                                      streaming={
                                        agentView() === undefined &&
                                        busy() &&
                                        index() === displayed().length - 1
                                      }
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
        </box>
        <Show when={layout().sidebar && !pagerOpen() && !setup()}>
          <Sidebar
            width={layout().sidebarWidth}
            model={modelRef() ?? "not configured"}
            effort={reasoning()}
            planMode={planMode()}
            todos={planTodos()}
            agents={agents()}
            showAgents={!layout().agentsPane}
            selectedAgentKey={agentView()}
            usage={{
              ctxUsed: ctxUsed(),
              ...(ctxLimit() !== undefined ? { ctxLimit: ctxLimit() } : {}),
              input: sessionUsage().input,
              output: sessionUsage().output,
              cacheRead: sessionUsage().cacheRead,
              costUSD: formatUSD(sessionCost()),
            }}
            files={changedFiles()}
            shells={shells()}
            now={clock()}
          />
        </Show>
      </box>

      {/* Narrow layout: plan + agents pinned above the composer. */}
      <Show when={layout().strip && !pagerOpen() && !setup()}>
        <PinnedStrip
          todos={planTodos()}
          agents={agents()}
          width={dimensions().width}
          expanded={planExpanded()}
          shells={shells()}
          now={clock()}
        />
      </Show>

      {/* /loop run live card: folds LoopEvents into one line (iteration,
          queue counts, last gate, tokens). Never shown with an approval
          prompt, since loop iterations have no `ask` callback. */}
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

      {/* Approval prompt: the question on one line, answers muted below.
          Long targets middle-ellipsize instead of wrapping. */}
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
            {/* While the pager owns the keyboard, none of these keys work;
                say so. */}
            <Show
              when={!pagerOpen()}
              fallback={<text fg={themeTokens().warn}>close the pager (Esc) to answer</text>}
            >
              <box flexDirection="row">
                <text fg={themeTokens().muted}>[y]es · [n]o</text>
                {/* Quick-add preview: exactly the rule [a] would write,
                    computed at ask time. Absent for plain confirmations or
                    when planQuickAdd refused. */}
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

      {/* /provider's key step: reuses the composer below with a
          keep-vs-replace hint. An overlay, not a full takeover, so the
          transcript stays visible mid-session. */}
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
              // Label with the token that matched (name or alias), noting the
              // primary command when it differs.
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
            // High-rate paste fallback for terminals without bracketed
            // paste. Only runs when usePaste didn't intercept the paste, so
            // it's safe unconditionally (see paste.ts for the rate threshold).
            // Gated like usePaste (not on busy()/pendingAsk()). The image
            // attach above keeps its own !busy() gate since it commits an
            // attachment to the next turn.
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
            ? // elapsedText() re-renders each second via elapsedTick(). While a
              // command runs, say so: "thinking" over a long build reads like a hang.
              `${SPINNER[spin()]} ${runningShellCount() > 0 ? `running ${runningShellCount() === 1 ? "a command" : `${runningShellCount()} commands`}… (Ctrl+X S to watch)` : "thinking…"} ${elapsedText()}  `
            : status()
              ? `${status()}  `
              : // idle default: model, cwd and a hint
                `${modelRef() ?? "not configured"}  ·  ${basename(props.cwd)}  ·  /help for commands`}
        </text>
        {/* Meters (ctx gauge, $ spend, queued count) right-align via the
            spacer; hidden below STATUS_METERS_MIN_WIDTH so they never
            collide with the status text. */}
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
