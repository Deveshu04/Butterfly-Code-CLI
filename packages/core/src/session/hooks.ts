import { runCommand } from "../tool/shell"


export const HOOK_EVENTS = [
  "session.start",
  "turn.start",
  "pre.tool",
  "post.tool",
  "turn.end",
] as const
export type HookEvent = (typeof HOOK_EVENTS)[number]

export interface HookConfig {
  event: HookEvent
  /** Wildcard on the tool name (pre.tool/post.tool only), e.g. "edit" or "*". */
  match?: string
  command: string
  feedback?: boolean
  enabled?: boolean
}

export interface HookRunResult {
  /** true when a pre.tool hook exited non-zero — the tool must not run. */
  blocked: boolean
  reason?: string
  ran: number
  /** Failing feedback-check output for the model (post.tool). */
  feedback?: string
}

export interface HookRunRecord {
  event: HookEvent
  command: string
  exitCode: number
  durationMs: number
  blocked: boolean
  feedback: boolean
  outputHead: string
}

const HOOK_OUTPUT_HEAD_CHARS = 500

function wildcard(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`).test(value)
}

export function hookMatches(hook: HookConfig, event: HookEvent, tool?: string): boolean {
  if (hook.event !== event) return false
  if (hook.match === undefined) return true
  return wildcard(hook.match, tool ?? "")
}

const HOOK_TIMEOUT_MS = 30_000

export async function runHooks(
  hooks: HookConfig[],
  event: HookEvent,
  ctx: { cwd: string; tool?: string; input?: unknown },
  opts: { onRun?: (run: HookRunRecord) => void } = {},
): Promise<HookRunResult> {
  let ran = 0
  const feedbackParts: string[] = []
  for (const hook of hooks) {
    if (hook.enabled === false) continue
    if (!hookMatches(hook, event, ctx.tool)) continue
    ran += 1
    const started = Date.now()
    const result = await runCommand(hook.command, {
      cwd: ctx.cwd,
      timeoutMs: HOOK_TIMEOUT_MS,
      env: {
        BUTTERFLY_EVENT: event,
        BUTTERFLY_TOOL: ctx.tool ?? "",
        BUTTERFLY_TOOL_INPUT: ctx.input !== undefined ? JSON.stringify(ctx.input) : "",
      },
    })
    const durationMs = Date.now() - started
    const combined = `${result.stdout}\n${result.stderr}`.trim()

    let blocked = false
    let reason: string | undefined
    if (event === "pre.tool" && (result.exitCode !== 0 || result.timedOut)) {
      blocked = true
      reason = combined.slice(0, 500) || `hook exited ${result.exitCode}`
    }

    let gaveFeedback = false
    if (event === "post.tool" && hook.feedback && (result.exitCode !== 0 || result.timedOut)) {
      gaveFeedback = true
      const output = combined.slice(0, 1_500)
      feedbackParts.push(
        `[check "${hook.command.slice(0, 60)}" failed (exit ${result.timedOut ? "timeout" : result.exitCode})]\n${output}`,
      )
    }

    opts.onRun?.({
      event,
      command: hook.command,
      exitCode: result.exitCode,
      durationMs,
      blocked,
      feedback: gaveFeedback,
      outputHead: combined.slice(0, HOOK_OUTPUT_HEAD_CHARS),
    })

    if (blocked) return { blocked: true, reason, ran }
  }
  return {
    blocked: false,
    ran,
    ...(feedbackParts.length > 0 ? { feedback: feedbackParts.join("\n\n") } : {}),
  }
}
