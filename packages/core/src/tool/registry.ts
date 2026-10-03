import { z } from "zod"
import { type PermissionRules, resolvePermissionWithSource } from "../permission/tree"
import type { ToolSpec } from "../provider/port"
import { repairToolInput, resolveToolName } from "./repair"
import { type SettleOptions, settle } from "./settle"

export interface AskDenial {
  decision: "deny"
  /** Lower-case fragment, e.g. "permission request timed out after 120000ms". */
  reason: string
}

export type AskDecision = "allow" | "deny" | AskDenial

export interface AskRequest {
  tool: string
  target?: string
  note?: string
  input: unknown
}

export interface SubagentUpdate {
  id: string
  index: number
  total: number
  /** The subagent's brief. */
  task: string
  model: string
  isolation: boolean
  phase: "queued" | "running" | "done" | "failed"
  /** Tool calls made so far. */
  steps: number
  /** One ASCII line: what it is doing right now. */
  activity: string
  /** Its own journal (written live) — a client can replay it to show the conversation. */
  journalPath?: string
}

export interface ToolContext {
  cwd: string
  rules: PermissionRules
  /** UI callback for "ask" decisions. Absent (headless): ask resolves to deny. */
  ask?: (request: AskRequest) => Promise<AskDecision>
  /** Session-scoped mutable state bag shared by tools (e.g. the todo list). */
  state: Record<string, unknown>
  settle?: SettleOptions
  signal?: AbortSignal
  beforeExecute?: (toolName: string) => Promise<void>
  /** Provider call id of the call being executed (runner-supplied). */
  callId?: string
  isResultVisible?: (callId: string) => boolean
  /** Honor tools' autoAllow for blanket asks (default true). */
  autoApproveReadOnly?: boolean
  /** UI-only live status for this call (runner → RunnerEvent "tool-progress"). */
  progress?: (text: string) => void
  /** UI-only structured subagent status (runner → RunnerEvent "subagent"). */
  subagent?: (update: SubagentUpdate) => void
}

export interface ToolOutcome {
  output: string
  isError?: boolean
  meta?: unknown
}

export interface ToolDefinition<I = unknown> {
  name: string
  description: string
  inputSchema: z.ZodType<I>
  /** Maps input to the permission-tree target (command string, file path…). */
  permissionTarget?: (input: I) => string | undefined
  /** Extra disclosure for the approval prompt only — never used for matching. */
  permissionNote?: (input: I) => string | undefined
  /**
   * True when this exact call is provably side-effect free (e.g. a
   * read-only shell pipeline). Lets a BLANKET "ask" resolve to allow;
   * explicit user patterns and denies are never softened.
   */
  autoAllow?: (input: I) => boolean
  execute(input: I, ctx: ToolContext): Promise<ToolOutcome>
}

export interface ToolRunResult {
  output: string
  isError: boolean
  truncated: boolean
  /** UI-only metadata from the tool, passed through untouched. */
  meta?: unknown
}

interface RegisteredTool {
  name: string
  description: string
  inputSchema: z.ZodType
  permissionTarget?: (input: unknown) => string | undefined
  permissionNote?: (input: unknown) => string | undefined
  autoAllow?: (input: unknown) => boolean
  execute(input: unknown, ctx: ToolContext): Promise<ToolOutcome>
}

function errorResult(output: string): ToolRunResult {
  return { output, isError: true, truncated: false }
}

export function describeDenial(
  name: string,
  target: string | undefined,
  answer: Exclude<AskDecision, "allow">,
): string {
  const on = target ? ` on "${target}"` : ""
  if (answer === "deny") return `User denied ${name}${on}.`
  return `${name}${on} was not approved — ${answer.reason}. The user never answered; do not treat this as their decision. Do not retry this exact call.`
}

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>()

  register<I>(tool: ToolDefinition<I>): void {
    this.tools.set(tool.name, tool as unknown as RegisteredTool)
  }

  list(): ToolSpec[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.inputSchema) as Record<string, unknown>,
    }))
  }

  async run(calledName: string, calledInput: unknown, ctx: ToolContext): Promise<ToolRunResult> {
    const notes: string[] = []
    let name = calledName
    if (!this.tools.has(name)) {
      const resolved = resolveToolName(name, this.tools.keys())
      if (resolved === undefined) {
        return errorResult(
          `Unknown tool "${name}". Available tools: ${[...this.tools.keys()].join(", ")}`,
        )
      }
      notes.push(`called as "${calledName}" — the tool is named "${resolved}"`)
      name = resolved
    }
    const tool = this.tools.get(name)
    if (!tool) return errorResult(`Unknown tool "${name}".`)

    const repaired = repairToolInput(calledInput)
    if (repaired.note) notes.push(repaired.note)
    const rawInput = repaired.input
    const withNotes = (result: ToolRunResult): ToolRunResult =>
      notes.length === 0
        ? result
        : { ...result, output: `${result.output}\n[harness note: ${notes.join("; ")}]` }

    // One method on purpose: splitting the rest into an awaited helper adds
    // microtask hops between the approval answer and the caller, which
    // breaks the interrupt-during-approval ordering the TUI pins (a denied
    // call's tool.result must land before the interrupt frame).
    const parsed = tool.inputSchema.safeParse(rawInput)
    if (!parsed.success) {
      const details = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(input)"}: ${issue.message}`)
        .join("; ")
      return withNotes(
        errorResult(`Invalid input for ${name} — ${details}. Fix the arguments and retry.`),
      )
    }

    const target = tool.permissionTarget?.(parsed.data)
    const resolved = resolvePermissionWithSource(ctx.rules, name, target)
    const decision =
      resolved.decision === "ask" &&
      resolved.blanket &&
      ctx.autoApproveReadOnly !== false &&
      tool.autoAllow?.(parsed.data) === true
        ? "allow"
        : resolved.decision
    if (decision === "deny") {
      return withNotes(
        errorResult(
          `Permission denied for ${name}${target ? ` on "${target}"` : ""} by policy. Do not retry this exact call.`,
        ),
      )
    }
    if (decision === "ask") {
      if (!ctx.ask) {
        return withNotes(
          errorResult(
            `${name}${target ? ` on "${target}"` : ""} requires approval, but no approver is available in this mode. Adjust the permission rules or run interactively.`,
          ),
        )
      }
      const note = tool.permissionNote?.(parsed.data)
      const answer = await ctx.ask({
        tool: name,
        target,
        ...(note ? { note } : {}),
        input: parsed.data,
      })
      if (answer !== "allow") {
        return withNotes(errorResult(describeDenial(name, target, answer)))
      }
    }

    if (ctx.beforeExecute) {
      try {
        await ctx.beforeExecute(name)
      } catch {
      }
    }

    try {
      const outcome = await tool.execute(parsed.data, ctx)
      const settled = settle(outcome.output, ctx.settle)
      return withNotes({
        output: settled.text,
        isError: outcome.isError ?? false,
        truncated: settled.truncated,
        ...(outcome.meta !== undefined ? { meta: outcome.meta } : {}),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return withNotes(errorResult(`Tool ${name} failed: ${message}`))
    }
  }
}
