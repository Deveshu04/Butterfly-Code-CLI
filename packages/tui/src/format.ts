/** Display-side text hygiene. Journals always keep the raw text. */

import type { Usage } from "@butterfly/core"
import { osc52CapLabel } from "./clipboard"

/** Humanizes a token count: `2400` -> `"2.4k"`, under 1000 as a plain integer. Clamps at 0. */
export function humanizeTokens(n: number): string {
  const value = Math.max(0, n)
  if (value < 1000) return String(Math.round(value))
  return `${(value / 1000).toFixed(1)}k`
}

/**
 * Middle-ellipsizes a single-line value (path, approval target) to `maxLen`
 * columns, keeping both the identifying prefix and suffix.
 */
export function middleEllipsize(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  if (maxLen <= 1) return "…".slice(0, Math.max(0, maxLen))
  const keep = maxLen - 1
  const head = Math.ceil(keep / 2)
  const tail = keep - head
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}

export interface ThinkSplit {
  /** Text with every <think>…</think> block removed. */
  rest: string
  /** Inner text of every think block, closed or still streaming. */
  thinking: string
  /** True when `text` ends inside an unterminated think block. */
  open: boolean
}

/**
 * Splits inline <think>…</think> reasoning (emitted as plain text by some
 * local models, e.g. qwen3 via Ollama) from the answer, so it can feed the
 * same thinking-block UI as native reasoning streams.
 */
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

/** Answer text with <think>…</think> blocks removed; same as `splitThink(text).rest`. */
export function stripThink(text: string): string {
  return splitThink(text).rest
}

/** Preview lines for tool output: more for errors, with an "N more lines" count. */
function previewLines(output: string, isError: boolean): { shown: string[]; hidden: number } {
  const lines = output.split("\n").filter((line) => line.trim() !== "")
  const keep = isError ? 5 : 2
  const shown = lines.slice(0, keep).map((line) => line.slice(0, 160))
  const hidden = lines.length - Math.min(lines.length, keep)
  return { shown, hidden }
}

/** Multi-line tool result preview prefixed with a plain "ok"/"failed" status word. */
export function formatToolResult(output: string, isError: boolean): string {
  const { shown, hidden } = previewLines(output, isError)
  const body = shown.map((line) => `  ${line}`)
  if (hidden > 0) body.push(`  … ${hidden} more line${hidden === 1 ? "" : "s"}`)
  return `${isError ? "failed" : "ok"} ${body.join("\n").trimStart()}`
}

/**
 * Like formatToolResult without the status word or indent; the bash command
 * cell already shows the exit status.
 */
export function formatCommandBody(output: string, isError: boolean): string {
  const { shown, hidden } = previewLines(output, isError)
  if (hidden > 0) shown.push(`… ${hidden} more line${hidden === 1 ? "" : "s"}`)
  return shown.join("\n")
}

/** Formats a duration in whole seconds: `72_000` -> `"1m 12s"`, `9_400` -> `"9s"`. */
export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

/**
 * Status-bar marker for the last turn, e.g. `in 12.3k · out 1.2k · cached 0 ·
 * 3 steps · 1m 23s`. Durations aren't journaled, so resumed turns omit it.
 */
export function turnMarker(usage: Usage, steps: number, durationMs?: number): string {
  const base = `in ${humanizeTokens(usage.input)} · out ${humanizeTokens(usage.output)} · cached ${humanizeTokens(usage.cacheRead)} · ${steps} steps`
  return durationMs === undefined ? base : `${base} · ${formatDuration(durationMs)}`
}

/**
 * Below this width the input-bar meters (context, spend, queue) are dropped,
 * since they would collide with the unbounded left-hand status text.
 */
export const STATUS_METERS_MIN_WIDTH = 80

/** True when the terminal is wide enough to show the status-bar meters. */
export function metersFitAt(columns: number): boolean {
  return columns >= STATUS_METERS_MIN_WIDTH
}

/**
 * Transient status-bar notice after a selection is copied. Uses the status
 * line rather than the transcript because it can fire many times a session.
 */
export function copyStatusText(truncated: boolean): string {
  return truncated ? `copied first ${osc52CapLabel()} (selection truncated)` : "copied"
}

/**
 * Shown once per session, on the first copy attempt, when the terminal lacks
 * OSC 52. Goes to the transcript so the next spinner tick can't wipe it.
 */
export const COPY_UNSUPPORTED_TEXT = "clipboard copy not supported by this terminal"
