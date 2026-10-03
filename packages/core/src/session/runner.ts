import { reconcileAgentsMd } from "../context/agents-md"
import type { ImageRef } from "../context/media"
import type { PermissionRules } from "../permission/tree"
import { type ProviderErrorInfo, RETRYABLE_ERROR_KINDS } from "../provider/describe-error"
import type {
  FinishReason,
  ProviderPort,
  ReasoningEffort,
  ToolCallPart,
  TurnEvent,
} from "../provider/port"
import { computeCostUSD, type ModelCost } from "../provider/pricing"
import type { AskDecision, AskRequest, ToolRegistry, ToolRunResult } from "../tool/registry"
import { TODO_STATE_KEY, type TodoItem } from "../tool/tools/todo"
import { assemble } from "./assembly"
import { compactSession, type ModelLimits, needsCompaction } from "./compaction"
import { now, type SessionEvent, type Usage } from "./events"
import { type HookConfig, type HookRunRecord, runHooks } from "./hooks"
import { SessionJournal } from "./journal"
import { foldTimeline, PRUNED_PLACEHOLDER, project } from "./projector"
import { planPrune } from "./prune"
import { isTodoCall, todosFromTimeline } from "./todo-state"

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
  | { type: "step-retracted"; attempt: number }

export interface RunnerDeps {
  provider: ProviderPort
  registry: ToolRegistry
  journal: SessionJournal
  rules: PermissionRules
  model: string
  system: string
  cwd: string
  ask?: (request: AskRequest) => Promise<AskDecision>
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
  /** Code-graph map of files, appended to compaction summaries (see harnessRecord). */
  codeMap?: (files: string[]) => string
  /** Thinking-effort dial, forwarded to the provider. */
  reasoning?: ReasoningEffort
  /** Pre-turn / pre-tool-call worktree snapshot (git tree hash or null). */
  createSnapshot?: (cwd: string) => Promise<string | null>
  listUntracked?: (cwd: string) => Promise<string[]>
  /** USD/1M-token pricing (models.dev) — enables cost accounting. */
  cost?: ModelCost
  /** Pricing for `smallModel` (compaction). Absent: priced at `cost`. */
  smallModelCost?: ModelCost
  maxSpendUSD?: number
  retries?: number
  autoContinue?: number
  /** Lifecycle hooks — pre.tool hooks can BLOCK a tool call. */
  hooks?: HookConfig[]
  /** Provably read-only calls skip blanket asks (default true; config autoApproveReadOnly). */
  autoApproveReadOnly?: boolean
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
  costUSD: number
  delegatedUsage: Usage
  interrupted: boolean
}

export const DEFAULT_MAX_STEPS = 50
export const DEFAULT_RETRIES = 3
/** Auto-continue nudges per turn (RunnerDeps.autoContinue). */
export const DEFAULT_AUTO_CONTINUE = 2
const RETRY_BASE_MS = 2_000

export function computeRetryBackoffMs(attempt: number, retryAfterSec?: number): number {
  if (retryAfterSec !== undefined) return Math.max(0, Math.round(retryAfterSec * 1000))
  const ceiling = RETRY_BASE_MS * 2 ** (attempt - 1)
  return Math.round(Math.random() * ceiling)
}

function retryReasonClause(info: ProviderErrorInfo | undefined): string {
  if (!info) return "provider error"
  switch (info.kind) {
    case "rate_limit":
      return `rate limited${info.provider ? ` by ${info.provider}` : ""}`
    case "unavailable":
      return `provider unavailable/overloaded${info.provider ? ` (${info.provider})` : ""}`
    case "timeout":
      return "request timed out"
    case "network":
      return "network error reaching the provider"
    default:
      return info.message
  }
}

function sleepAbortable(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(true)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve(false)
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

const ABORTED: unique symbol = Symbol("aborted")

function raceAbortAfterArmed<T>(
  promise: Promise<T>,
  armed: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<T | typeof ABORTED> {
  if (!signal) return promise
  let settled = false
  let removeAbortListener = (): void => {}
  const abortedAfterArm: Promise<typeof ABORTED> = armed.then(
    () =>
      new Promise<typeof ABORTED>((resolve) => {
        if (signal.aborted) {
          resolve(ABORTED)
          return
        }
        if (settled) return
        const onAbort = () => resolve(ABORTED)
        signal.addEventListener("abort", onAbort, { once: true })
        removeAbortListener = () => signal.removeEventListener("abort", onAbort)
      }),
  )
  const race = Promise.race([promise, abortedAfterArm])
  race.then(
    () => {
      settled = true
      removeAbortListener()
    },
    () => {
      settled = true
      removeAbortListener()
    },
  )
  return race
}

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
  /** Delegated spend (see TurnOutcome.delegatedUsage). */
  const delegated: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let delegatedCostUSD = 0
  const addDelegated = (usage: Usage, costUSD: number | undefined, fallback?: ModelCost): void => {
    delegated.input += usage.input
    delegated.output += usage.output
    delegated.cacheRead += usage.cacheRead
    delegated.cacheWrite += usage.cacheWrite
    const pricing = fallback ?? deps.cost
    delegatedCostUSD += costUSD ?? (pricing ? computeCostUSD(usage, pricing) : 0)
  }
  const compactionPricing = (): ModelCost | undefined =>
    deps.smallModel !== undefined ? (deps.smallModelCost ?? deps.cost) : deps.cost
  const spentUSD = (): number =>
    (deps.cost ? computeCostUSD(totals, deps.cost) : 0) + delegatedCostUSD
  let lastText = ""
  let steps = 0
  let budgetExceeded = false
  let interrupted = false
  let warned75 = false
  let warned90 = false
  let continuations = 0
  let lengthNudged = false
  /** Context-overflow recovery runs at most once per turn. */
  let overflowRecovered = false
  let lastNudgeTodos: string | undefined
  let todoTouched = false
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
  {
    const { events } = SessionJournal.replay(journal.path)
    const todos = todosFromTimeline(foldTimeline(events).entries.map((entry) => entry.event))
    if (todos) state[TODO_STATE_KEY] = todos
    else delete state[TODO_STATE_KEY]
  }

  const planContinuation = (
    reason: FinishReason | undefined,
  ): { text: string; notice: string } | null => {
    const limit = deps.autoContinue ?? DEFAULT_AUTO_CONTINUE
    if (limit <= 0 || continuations >= limit) return null
    if (reason === "length" && !lengthNudged) {
      lengthNudged = true
      return {
        text: "[harness] Your last reply was cut off by the output-token limit. Continue exactly where it stopped — do not repeat what you already wrote.",
        notice: `reply hit the output limit — continuing (${continuations + 1}/${limit})`,
      }
    }
    if (reason !== "stop" || !todoTouched) return null
    const todos = (state[TODO_STATE_KEY] as TodoItem[] | undefined) ?? []
    const open = todos.filter((item) => item.status !== "completed")
    if (open.length === 0) return null
    const fingerprint = JSON.stringify(todos)
    if (fingerprint === lastNudgeTodos) return null
    lastNudgeTodos = fingerprint
    const list = open
      .map((item) => `${item.status === "in_progress" ? "[~]" : "[ ]"} ${item.text}`)
      .join("\n")
    return {
      text: `[harness] You stopped, but your todo list still has ${open.length} unfinished item(s):\n${list}\nKeep going until they are done. If an item is actually finished, blocked, or no longer needed, update the todo list to say so (and why) — then end with a short summary.`,
      notice: `${open.length} todo(s) still open — continuing (${continuations + 1}/${limit})`,
    }
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

    /** Results the model can see in THIS step's request (read dedup). */
    const visibleResults = new Set<string>()
    const buildMessages = (source: SessionEvent[]) => {
      const projected = project(header, source)
      visibleResults.clear()
      for (const event of projected.timeline) {
        if (event.type === "tool.result" && !event.isError && event.output !== PRUNED_PLACEHOLDER) {
          visibleResults.add(event.callId)
        }
      }
      return assemble({
        system: deps.system,
        timeline: projected.timeline,
        imageInputSupported: deps.imageInputSupported === true,
      })
    }
    let messages = buildMessages(timelineEvents)

    let stepText = ""
    const toolCalls: ToolCallPart[] = []
    let finish: { reason: FinishReason; usage: Usage } | undefined

    const maxRetries = deps.retries ?? DEFAULT_RETRIES
    let abortedInBackoff = false
    let attempt = 0
    for (;;) {
      attempt += 1
      stepText = ""
      toolCalls.length = 0
      finish = undefined
      let failure: Extract<TurnEvent, { type: "error" }> | undefined

      for await (const event of deps.provider.streamTurn({
        model: deps.model,
        messages,
        tools: registry.list(),
        ...(deps.reasoning !== undefined ? { reasoning: deps.reasoning } : {}),
        signal: deps.signal,
      })) {
        if (event.type === "error") {
          failure = event
          continue
        }
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
          default:
            break
        }
      }

      if (!failure) break

      const kind = failure.info?.kind

      if (kind === "context_length" && !overflowRecovered && !deps.signal?.aborted) {
        overflowRecovered = true
        const { events: current } = SessionJournal.replay(journal.path)
        const victims = planPrune(current, {
          ...(deps.pruneWindowTokens !== undefined ? { windowTokens: deps.pruneWindowTokens } : {}),
        })
        if (victims.length > 0) {
          journal.append({ type: "tool.pruned", callIds: victims, time: now() })
        }
        const compacted = await compactSession({
          provider: deps.provider,
          model: deps.smallModel ?? deps.model,
          journal,
          ...(deps.compactKeepTokens !== undefined ? { keepTokens: deps.compactKeepTokens } : {}),
          ...(deps.codeMap ? { codeMap: deps.codeMap } : {}),
        }).catch(() => null)
        if (compacted) addDelegated(compacted.usage, undefined, compactionPricing())
        if (victims.length > 0 || compacted) {
          deps.onEvent?.({ type: "step-retracted", attempt })
          deps.onEvent?.({
            type: "notice",
            text: "request exceeded the model's context window — compacted the transcript, retrying",
          })
          messages = buildMessages(SessionJournal.replay(journal.path).events)
          attempt -= 1 // the recovery is not a transient-failure retry
          continue
        }
      }

      const retryable = kind !== undefined && RETRYABLE_ERROR_KINDS.has(kind)
      if (!retryable || attempt > maxRetries) {
        deps.onEvent?.(failure)
        throw new Error(`Provider error: ${failure.message}`)
      }

      deps.onEvent?.({ type: "step-retracted", attempt })

      const waitMs = computeRetryBackoffMs(attempt, failure.info?.retryAfterSec)
      deps.onEvent?.({
        type: "notice",
        text: `retrying (${attempt}/${maxRetries}) in ${Math.round(waitMs / 1000)}s — ${retryReasonClause(failure.info)}`,
      })
      if (await sleepAbortable(waitMs, deps.signal)) {
        interrupted = true
        abortedInBackoff = true
        break
      }
    }
    if (abortedInBackoff) break

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

    const abandonPendingCalls = (calls: ToolCallPart[], reason: string): void => {
      for (const call of calls) {
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

    if (
      deps.budgetTokens !== undefined &&
      totals.input + totals.output + delegated.input + delegated.output >= deps.budgetTokens
    ) {
      budgetExceeded = true
      abandonPendingCalls(toolCalls, "budget stop")
      break
    }

    if (deps.cost && deps.maxSpendUSD !== undefined) {
      const spent = spentUSD()
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
        abandonPendingCalls(toolCalls, "budget stop")
        break
      }
    }

    if (finish?.reason === "tool-calls" && toolCalls.length > 0) {
      if (toolCalls.some((call) => isTodoCall(call.name))) todoTouched = true
      for (const call of toolCalls) {
        if (interrupted || deps.signal?.aborted) {
          interrupted = true
          abandonPendingCalls([call], "interrupted")
          continue
        }

        const fingerprint = `${call.name}:${JSON.stringify(call.input)}`
        const seen = (callFingerprints.get(fingerprint) ?? 0) + 1
        callFingerprints.set(fingerprint, seen)

        let armExecuteRace: () => void = () => {}
        const armed = new Promise<void>((resolve) => {
          armExecuteRace = resolve
        })

        const raced = await raceAbortAfterArmed(
          (async (): Promise<{ result: ToolRunResult; hookBlock: string | undefined }> => {
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
                      callId: call.callId,
                      isResultVisible: (id) => visibleResults.has(id),
                      ...(deps.autoApproveReadOnly === false ? { autoApproveReadOnly: false } : {}),
                      rules: deps.rules,
                      ask: deps.ask,
                      state,
                      signal: deps.signal,
                      // The resolved name, not call.name: a repaired call
                      // ("run_command" → bash) still gets its checkpoint.
                      beforeExecute: async (toolName) => {
                        armExecuteRace()
                        if (deps.createSnapshot && MUTATING_TOOLS.has(toolName)) {
                          const tree = await deps.createSnapshot(deps.cwd)
                          if (!tree) return
                          const untracked = deps.listUntracked
                            ? await deps.listUntracked(deps.cwd)
                            : []
                          journal.append({
                            type: "turn.snapshot",
                            tree,
                            callId: call.callId,
                            tool: toolName,
                            argsPreview: firstLine(call.input),
                            untracked,
                            time: now(),
                          })
                        }
                      },
                    })
            return { result, hookBlock }
          })(),
          armed,
          deps.signal,
        )

        if (raced === ABORTED) {
          interrupted = true
          abandonPendingCalls([call], "interrupted")
          continue
        }
        const { result, hookBlock } = raced

        const spend = (result.meta as { spend?: { usage?: Usage; costUSD?: number } } | undefined)
          ?.spend
        if (spend?.usage) addDelegated(spend.usage, spend.costUSD)

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

      if (interrupted) {
        break
      }

      const { events: currentEvents } = SessionJournal.replay(journal.path)
      const victims = planPrune(currentEvents, {
        ...(deps.pruneWindowTokens !== undefined ? { windowTokens: deps.pruneWindowTokens } : {}),
      })
      if (victims.length > 0) {
        journal.append({ type: "tool.pruned", callIds: victims, time: now() })
      }
      if (deps.limits && finish && needsCompaction(finish.usage, deps.limits)) {
        const compacted = await compactSession({
          provider: deps.provider,
          model: deps.smallModel ?? deps.model,
          journal,
          ...(deps.compactKeepTokens !== undefined ? { keepTokens: deps.compactKeepTokens } : {}),
          ...(deps.codeMap ? { codeMap: deps.codeMap } : {}),
        })
        if (compacted) addDelegated(compacted.usage, undefined, compactionPricing())
      }
      continue
    }
    if (deps.signal?.aborted) interrupted = true
    abandonPendingCalls(toolCalls, "the turn ended before this call ran")

    if (!interrupted && toolCalls.length === 0 && steps < maxSteps) {
      const nudge = planContinuation(finish?.reason)
      if (nudge) {
        continuations += 1
        journal.append({
          type: "message.user",
          id: crypto.randomUUID(),
          text: nudge.text,
          synthetic: true,
          time: now(),
        })
        deps.onEvent?.({ type: "notice", text: nudge.notice })
        continue
      }
    }
    break
  }

  if (deps.hooks?.length) {
    await runHooks(deps.hooks, "turn.end", { cwd: deps.cwd }, { onRun: journalHookRun }).catch(
      () => {},
    )
  }
  journal.append({ type: "turn.completed", model: deps.model, usage: totals, time: now() })
  const costUSD = spentUSD()
  return {
    text: lastText,
    usage: totals,
    delegatedUsage: delegated,
    steps,
    budgetExceeded,
    costUSD,
    interrupted,
  }
}
