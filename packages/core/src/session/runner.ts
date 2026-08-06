import { reconcileAgentsMd } from "../context/agents-md"
import type { ImageRef } from "../context/media"
import type { PermissionRules } from "../permission/tree"
import type {
  FinishReason,
  ProviderPort,
  ReasoningEffort,
  ToolCallPart,
  TurnEvent,
} from "../provider/port"
import { computeCostUSD, type ModelCost } from "../provider/pricing"
import type { AskRequest, ToolRegistry } from "../tool/registry"
import { assemble } from "./assembly"
import { compactSession, type ModelLimits, needsCompaction } from "./compaction"
import { now, type SessionEvent, type Usage } from "./events"
import { type HookConfig, type HookRunRecord, runHooks } from "./hooks"
import { SessionJournal } from "./journal"
import { project } from "./projector"
import { planPrune } from "./prune"

export type RunnerEvent =
  | TurnEvent
  | {
      type: "tool-result"
      callId: string
      name: string
      output: string
      isError: boolean
      meta?: unknown
    }
  | { type: "notice"; text: string }

export interface RunnerDeps {
  provider: ProviderPort
  registry: ToolRegistry
  journal: SessionJournal
  rules: PermissionRules
  model: string
  system: string
  cwd: string
  ask?: (request: AskRequest) => Promise<"allow" | "deny">
  /** Session-scoped state shared with tools (todo list, …). */
  state?: Record<string, unknown>
  /** Guard against runaway loops. */
  maxSteps?: number
  /** Hard token ceiling for this turn (input+output); stops between steps. */
  budgetTokens?: number
  /** Tier-1 prune window (est. tokens); defaults to 40k. */
  pruneWindowTokens?: number
  /** Model context limits — enables tier-2 auto-compaction when provided. */
  limits?: ModelLimits
  /** Cheap summarizer model for compaction (defaults to the main model). */
  smallModel?: string
  /** Verbatim tail budget for compaction. */
  compactKeepTokens?: number
  /** Thinking-effort dial, forwarded to the provider. */
  reasoning?: ReasoningEffort
  /** Pre-turn / pre-tool-call worktree snapshot (git tree hash or null). */
  createSnapshot?: (cwd: string) => Promise<string | null>
  listUntracked?: (cwd: string) => Promise<string[]>
  /** USD/1M-token pricing (models.dev) — enables cost accounting. */
  cost?: ModelCost
  maxSpendUSD?: number
  /** Lifecycle hooks — pre.tool hooks can BLOCK a tool call. */
  hooks?: HookConfig[]
  /** UI stream hook — deltas, tool calls, tool results. */
  onEvent?: (event: RunnerEvent) => void
  signal?: AbortSignal
  imageInputSupported?: boolean
}

/** Per-turn options — kept separate from RunnerDeps since these vary every call. */
export interface RunUserTurnOptions {
  /** Images attached to this turn, already validated + hashed (context/media.ts). */
  images?: ImageRef[]
}

export interface TurnOutcome {
  text: string
  usage: Usage
  steps: number
  budgetExceeded: boolean
  /** 0 when pricing is unknown. */
  costUSD: number
}

export const DEFAULT_MAX_STEPS = 50

/** Tools that mutate the worktree — the ones that get a pre-call checkpoint. */
const MUTATING_TOOLS = new Set(["edit", "bash"])

/** First line of a value's JSON form, capped — checkpoint picker label context. */
function firstLine(value: unknown, maxLen = 120): string {
  const text = (() => {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  })()
  const line = text.split("\n")[0] ?? ""
  return line.length > maxLen ? `${line.slice(0, maxLen)}…` : line
}

/**
 * One user turn: append the user message, then loop provider steps —
 * executing tool calls between steps — until the model stops, the step
 * guard trips, or the token budget is exhausted. Exactly one turn.completed
 * event is journaled per user turn.
 */
export async function runUserTurn(
  deps: RunnerDeps,
  userText: string,
  opts?: RunUserTurnOptions,
): Promise<TurnOutcome> {
  const { journal, registry } = deps
  const journalHookRun = (run: HookRunRecord): void => {
    journal.append({ type: "hook.run", ...run, time: now() })
  }
  const maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS
  const state = deps.state ?? {}
  const totals: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let lastText = ""
  let steps = 0
  let budgetExceeded = false
  let warned75 = false
  let warned90 = false
  const callFingerprints = new Map<string, number>()
  const REPEAT_LIMIT = 3

  if (deps.createSnapshot) {
    try {
      const tree = await deps.createSnapshot(deps.cwd)
      if (tree) {
        const untracked = deps.listUntracked ? await deps.listUntracked(deps.cwd) : []
        journal.append({ type: "turn.snapshot", tree, untracked, time: now() })
      }
    } catch {
      // snapshots are best-effort — never block a turn
    }
  }
  const attachedImages = opts?.images ?? []
  journal.append({
    type: "message.user",
    id: crypto.randomUUID(),
    text: userText,
    ...(attachedImages.length > 0 ? { images: attachedImages } : {}),
    time: now(),
  })
  if (attachedImages.length > 0 && deps.imageInputSupported !== true) {
    deps.onEvent?.({
      type: "notice",
      text: `${attachedImages.length} image(s) not sent — ${deps.model} does not support image input: ${attachedImages.map((image) => image.path).join(", ")}`,
    })
  }
  if (deps.hooks?.length) {
    await runHooks(deps.hooks, "turn.start", { cwd: deps.cwd }, { onRun: journalHookRun }).catch(
      () => {},
    )
  }

  while (steps < maxSteps) {
    steps += 1

    const { header, events } = SessionJournal.replay(journal.path)

    let timelineEvents: SessionEvent[] = events
    const agentsMd = reconcileAgentsMd(events, deps.cwd)
    if (agentsMd.fragments.length > 0 || agentsMd.skipped.length > 0) {
      const fragmentEvent: SessionEvent = {
        type: "context.fragment",
        source: "agents.md",
        fragments: agentsMd.fragments,
        ...(agentsMd.skipped.length > 0 ? { skipped: agentsMd.skipped } : {}),
        ...(agentsMd.warning !== undefined ? { warning: agentsMd.warning } : {}),
        time: now(),
      }
      journal.append(fragmentEvent)
      timelineEvents = [...events, fragmentEvent]
    }

    const projected = project(header, timelineEvents)
    const messages = assemble({
      system: deps.system,
      timeline: projected.timeline,
      imageInputSupported: deps.imageInputSupported === true,
    })

    let stepText = ""
    const toolCalls: ToolCallPart[] = []
    let finish: { reason: FinishReason; usage: Usage } | undefined

    for await (const event of deps.provider.streamTurn({
      model: deps.model,
      messages,
      tools: registry.list(),
      ...(deps.reasoning !== undefined ? { reasoning: deps.reasoning } : {}),
      signal: deps.signal,
    })) {
      deps.onEvent?.(event)
      switch (event.type) {
        case "text-delta":
          stepText += event.text
          break
        case "tool-call":
          toolCalls.push({ callId: event.callId, name: event.name, input: event.input })
          break
        case "finish":
          finish = { reason: event.reason, usage: event.usage }
          break
        case "error":
          throw new Error(`Provider error: ${event.message}`)
        default:
          break
      }
    }

    if (finish) {
      totals.input += finish.usage.input
      totals.output += finish.usage.output
      totals.cacheRead += finish.usage.cacheRead
      totals.cacheWrite += finish.usage.cacheWrite
    }
    if (stepText !== "") lastText = stepText

    journal.append({
      type: "message.assistant",
      id: crypto.randomUUID(),
      text: stepText,
      time: now(),
    })
    for (const call of toolCalls) {
      journal.append({
        type: "tool.call",
        callId: call.callId,
        name: call.name,
        input: call.input,
        time: now(),
      })
    }

    const abandonPendingCalls = (reason: string): void => {
      for (const call of toolCalls) {
        const output = `[not executed — ${reason}]`
        deps.onEvent?.({
          type: "tool-result",
          callId: call.callId,
          name: call.name,
          output,
          isError: true,
        })
        journal.append({
          type: "tool.result",
          callId: call.callId,
          output,
          isError: true,
          time: now(),
        })
      }
    }

    if (deps.budgetTokens !== undefined && totals.input + totals.output >= deps.budgetTokens) {
      budgetExceeded = true
      abandonPendingCalls("budget stop")
      break
    }

    if (deps.cost && deps.maxSpendUSD !== undefined) {
      const spent = computeCostUSD(totals, deps.cost)
      const fraction = spent / deps.maxSpendUSD
      if (fraction >= 0.75 && !warned75) {
        warned75 = true
        deps.onEvent?.({
          type: "notice",
          text: `spend at ${Math.round(fraction * 100)}% of the $${deps.maxSpendUSD.toFixed(2)} budget`,
        })
      }
      if (fraction >= 0.9 && !warned90) {
        warned90 = true
        deps.onEvent?.({
          type: "notice",
          text: `spend at ${Math.round(fraction * 100)}% of the $${deps.maxSpendUSD.toFixed(2)} budget`,
        })
      }
      if (spent >= deps.maxSpendUSD) {
        budgetExceeded = true
        deps.onEvent?.({
          type: "notice",
          text: `dollar budget reached ($${spent.toFixed(2)} of $${deps.maxSpendUSD.toFixed(2)}) — stopping this turn`,
        })
        abandonPendingCalls("budget stop")
        break
      }
    }

    if (finish?.reason === "tool-calls" && toolCalls.length > 0) {
      for (const call of toolCalls) {
        const fingerprint = `${call.name}:${JSON.stringify(call.input)}`
        const seen = (callFingerprints.get(fingerprint) ?? 0) + 1
        callFingerprints.set(fingerprint, seen)

        let hookBlock: string | undefined
        if (deps.hooks?.length && seen < REPEAT_LIMIT) {
          const pre = await runHooks(
            deps.hooks,
            "pre.tool",
            { cwd: deps.cwd, tool: call.name, input: call.input },
            { onRun: journalHookRun },
          ).catch(() => ({ blocked: false as const, ran: 0 }))
          if (pre.blocked) hookBlock = pre.reason
        }
        const result =
          seen >= REPEAT_LIMIT
            ? {
                output: `You have made this identical ${call.name} call ${seen} times — it was NOT executed again. Repeating it will not change the result. Take a different action, or if the task is already complete, finish with a summary.`,
                isError: true,
                truncated: false,
              }
            : hookBlock !== undefined
              ? {
                  output: `Blocked by a pre.tool hook: ${hookBlock || "(no reason given)"}. This is project policy — do not retry the same call; adapt or explain.`,
                  isError: true,
                  truncated: false,
                }
              : await registry.run(call.name, call.input, {
                  cwd: deps.cwd,
                  rules: deps.rules,
                  ask: deps.ask,
                  state,
                  signal: deps.signal,
                  ...(deps.createSnapshot && MUTATING_TOOLS.has(call.name)
                    ? {
                        beforeExecute: async () => {
                          const tree = await deps.createSnapshot?.(deps.cwd)
                          if (!tree) return
                          const untracked = deps.listUntracked
                            ? await deps.listUntracked(deps.cwd)
                            : []
                          journal.append({
                            type: "turn.snapshot",
                            tree,
                            callId: call.callId,
                            tool: call.name,
                            argsPreview: firstLine(call.input),
                            untracked,
                            time: now(),
                          })
                        },
                      }
                    : {}),
                })
        let finalResult = result
        if (deps.hooks?.length && hookBlock === undefined && seen < REPEAT_LIMIT) {
          const post = await runHooks(
            deps.hooks,
            "post.tool",
            { cwd: deps.cwd, tool: call.name, input: call.input },
            { onRun: journalHookRun },
          ).catch(() => ({ blocked: false as const, ran: 0 }))
          if ("feedback" in post && post.feedback) {
            finalResult = {
              ...result,
              output: `${result.output}\n\n${post.feedback}\nFix these check failures before continuing.`,
              isError: true,
            }
          }
        }
        deps.onEvent?.({
          type: "tool-result",
          callId: call.callId,
          name: call.name,
          output: finalResult.output,
          isError: finalResult.isError,
          ...(finalResult.meta !== undefined ? { meta: finalResult.meta } : {}),
        })
        journal.append({
          type: "tool.result",
          callId: call.callId,
          output: finalResult.output,
          isError: finalResult.isError,
          truncated: finalResult.truncated || undefined,
          ...(finalResult.meta !== undefined ? { meta: finalResult.meta } : {}),
          time: now(),
        })
      }

      const { events: currentEvents } = SessionJournal.replay(journal.path)
      const victims = planPrune(currentEvents, {
        ...(deps.pruneWindowTokens !== undefined ? { windowTokens: deps.pruneWindowTokens } : {}),
      })
      if (victims.length > 0) {
        journal.append({ type: "tool.pruned", callIds: victims, time: now() })
      }
      if (deps.limits && finish && needsCompaction(finish.usage, deps.limits)) {
        await compactSession({
          provider: deps.provider,
          model: deps.smallModel ?? deps.model,
          journal,
          ...(deps.compactKeepTokens !== undefined ? { keepTokens: deps.compactKeepTokens } : {}),
        })
      }
      continue
    }
    abandonPendingCalls("the turn ended before this call ran")
    break
  }

  if (deps.hooks?.length) {
    await runHooks(deps.hooks, "turn.end", { cwd: deps.cwd }, { onRun: journalHookRun }).catch(
      () => {},
    )
  }
  journal.append({ type: "turn.completed", model: deps.model, usage: totals, time: now() })
  const costUSD = deps.cost ? computeCostUSD(totals, deps.cost) : 0
  return { text: lastText, usage: totals, steps, budgetExceeded, costUSD }
}
