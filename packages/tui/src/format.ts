/** Display-side text hygiene. Journals always keep the raw text. */

import type { Usage } from "@butterfly/core"
import { osc52CapLabel } from "./clipboard"

export function humanizeTokens(n: number): string {
  const value = Math.max(0, n)
  if (value < 1000) return String(Math.round(value))
  return `${(value / 1000).toFixed(1)}k`
}

export function middleEllipsize(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  if (maxLen <= 1) return "…".slice(0, Math.max(0, maxLen))
  const keep = maxLen - 1
  const head = Math.ceil(keep / 2)
  const tail = keep - head
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}

export interface ThinkSplit {
  rest: string
  thinking: string
  open: boolean
}

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

export function stripThink(text: string): string {
  return splitThink(text).rest
}

function previewLines(output: string, isError: boolean): { shown: string[]; hidden: number } {
  const lines = output.split("\n").filter((line) => line.trim() !== "")
  const keep = isError ? 5 : 2
  const shown = lines.slice(0, keep).map((line) => line.slice(0, 160))
  const hidden = lines.length - Math.min(lines.length, keep)
  return { shown, hidden }
}

export function formatToolResult(output: string, isError: boolean): string {
  const { shown, hidden } = previewLines(output, isError)
  const body = shown.map((line) => `  ${line}`)
  if (hidden > 0) body.push(`  … ${hidden} more line${hidden === 1 ? "" : "s"}`)
  return `${isError ? "failed" : "ok"} ${body.join("\n").trimStart()}`
}

export function formatCommandBody(output: string, isError: boolean): string {
  const { shown, hidden } = previewLines(output, isError)
  if (hidden > 0) shown.push(`… ${hidden} more line${hidden === 1 ? "" : "s"}`)
  return shown.join("\n")
}

export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

export function turnMarker(usage: Usage, steps: number, durationMs?: number): string {
  const base = `in ${humanizeTokens(usage.input)} · out ${humanizeTokens(usage.output)} · cached ${humanizeTokens(usage.cacheRead)} · ${steps} steps`
  return durationMs === undefined ? base : `${base} · ${formatDuration(durationMs)}`
}

export const STATUS_METERS_MIN_WIDTH = 80

export function metersFitAt(columns: number): boolean {
  return columns >= STATUS_METERS_MIN_WIDTH
}

export function copyStatusText(truncated: boolean): string {
  return truncated ? `copied first ${osc52CapLabel()} (selection truncated)` : "copied"
}

export const COPY_UNSUPPORTED_TEXT = "clipboard copy not supported by this terminal"
