import { basename } from "node:path"

/**
 * Pure attention logic: maps a moment (turn end, approval request) plus focus
 * state and config to actions (notify / title / progress) with exact escape
 * sequences. TUI and headless adapters only apply the actions. Progress uses
 * OSC 9;4 (ConEmu/Windows Terminal), written raw since OpenTUI has no API.
 */

/** Terminal window focus. Headless has no window and counts as blurred. */
export type FocusState = "focused" | "blurred"

export type AttentionEvent =
  | { kind: "turn.start" }
  | { kind: "turn.progress"; percent?: number }
  | { kind: "turn.end"; detail?: string }
  | { kind: "approval.request"; detail?: string }

export interface AttentionState {
  focus: FocusState
  cwd: string
}

export interface AttentionConfig {
  notifications: boolean
}

export interface NotifyAction {
  type: "notify"
  /** Sanitized, clamped to 240 chars. */
  message: string
  /** Sanitized, clamped to 80 chars. */
  title: string
  /** OSC 9 + OSC 777 + BEL fallback chain, for adapters with no notification API. */
  osc: string
}

export interface TitleAction {
  type: "title"
  /** "busy — repo" | "idle — repo". Sanitized like a notify title: the repo
   * directory name is untrusted and could inject BEL/ESC into the OSC. */
  text: string
  /** OSC 0 (xterm set-title), for adapters with no setTerminalTitle API. */
  osc: string
}

export interface ProgressAction {
  type: "progress"
  /** OSC 9;4 (ConEmu/Windows Terminal progress). */
  osc: string
}

export type AttentionAction = NotifyAction | TitleAction | ProgressAction

const NOTIFY_MESSAGE_MAX = 240
/** Shared by notify titles and terminal titles — same clamp semantics. */
const TITLE_MAX = 80
const DEFAULT_NOTIFY_TITLE = "butterfly code"

// Strips CSI sequences only; enough for notification text, not a full strip-ansi.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the ESC (\x1b) IS the thing being matched — this strips ANSI escapes out of notify text.
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
// Control chars other than the ones we already normalize (CR/LF -> space).
// biome-ignore lint/suspicious/noControlCharactersInRegex: the control-char range IS the thing being matched — this strips them out of notify text.
const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

function sanitize(text: string, maxLen: number): string {
  const cleaned = text
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(/[\r\n]+/g, " ")
    .replace(CONTROL_CHAR_PATTERN, "")
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned
}

function clampPercent(percent: number): number {
  return Math.max(0, Math.min(100, Math.round(percent)))
}

function buildNotifyOsc(message: string, title: string): string {
  return `\x1b]9;${message}\x07\x1b]777;notify;${title};${message}\x07\x07`
}

function buildTitleOsc(title: string): string {
  return `\x1b]0;${title}\x07`
}

/** ConEmu/Windows Terminal OSC 9;4 states: 0 clear, 1 percent, 3 indeterminate. */
function buildProgressOsc(state: 0 | 1 | 3, percent = 0): string {
  return `\x1b]9;4;${state};${percent}\x07`
}

function makeNotify(rawMessage: string, rawTitle: string): NotifyAction {
  const message = sanitize(rawMessage, NOTIFY_MESSAGE_MAX)
  const title = sanitize(rawTitle, TITLE_MAX)
  return { type: "notify", message, title, osc: buildNotifyOsc(message, title) }
}

function makeTitle(state: AttentionState, busy: boolean): TitleAction {
  // basename(cwd) is untrusted and lands in an OSC 0 payload; sanitize it.
  const text = sanitize(`${busy ? "busy" : "idle"} — ${basename(state.cwd)}`, TITLE_MAX)
  return { type: "title", text, osc: buildTitleOsc(text) }
}

/**
 * The bare "clear progress" sequence for synchronous cleanup paths (exit
 * hooks, crash restore). Same bytes `turn.end` emits.
 */
export function clearProgressOsc(): string {
  return buildProgressOsc(0)
}

/**
 * Notifications fire only when not focused, on turn end and approval
 * requests. `notifications: false` disables notify actions only.
 */
export function decideAttention(
  event: AttentionEvent,
  state: AttentionState,
  config: AttentionConfig,
): AttentionAction[] {
  const notFocused = state.focus !== "focused"
  switch (event.kind) {
    case "turn.start":
      return [makeTitle(state, true), { type: "progress", osc: buildProgressOsc(3) }]

    case "turn.progress":
      if (event.percent === undefined) return []
      return [{ type: "progress", osc: buildProgressOsc(1, clampPercent(event.percent)) }]

    case "turn.end": {
      const actions: AttentionAction[] = [
        makeTitle(state, false),
        { type: "progress", osc: buildProgressOsc(0) },
      ]
      if (config.notifications && notFocused) {
        const message = event.detail ? `turn finished: ${event.detail}` : "turn finished"
        actions.push(makeNotify(message, DEFAULT_NOTIFY_TITLE))
      }
      return actions
    }

    case "approval.request": {
      if (!config.notifications || !notFocused) return []
      const message = event.detail ? `approval needed: ${event.detail}` : "approval needed"
      return [makeNotify(message, DEFAULT_NOTIFY_TITLE)]
    }

    default:
      return []
  }
}
