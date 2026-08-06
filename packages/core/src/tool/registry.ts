import { z } from "zod"
import { type PermissionRules, resolvePermission } from "../permission/tree"
import type { ToolSpec } from "../provider/port"
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

export interface ToolContext {
  cwd: string
  rules: PermissionRules
  /** UI callback for "ask" decisions. Absent (headless): ask resolves to deny. */
  ask?: (request: AskRequest) => Promise<AskDecision>
  /** Session-scoped mutable state bag shared by tools (e.g. the todo list). */
  state: Record<string, unknown>
  settle?: SettleOptions
  signal?: AbortSignal
  beforeExecute?: () => Promise<void>
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

  async run(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolRunResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      return errorResult(
        `Unknown tool "${name}". Available tools: ${[...this.tools.keys()].join(", ")}`,
      )
    }

    const parsed = tool.inputSchema.safeParse(rawInput)
    if (!parsed.success) {
      const details = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(input)"}: ${issue.message}`)
        .join("; ")
      return errorResult(`Invalid input for ${name} — ${details}. Fix the arguments and retry.`)
    }

    const target = tool.permissionTarget?.(parsed.data)
    const decision = resolvePermission(ctx.rules, name, target)
    if (decision === "deny") {
      return errorResult(
        `Permission denied for ${name}${target ? ` on "${target}"` : ""} by policy. Do not retry this exact call.`,
      )
    }
    if (decision === "ask") {
      if (!ctx.ask) {
        return errorResult(
          `${name}${target ? ` on "${target}"` : ""} requires approval, but no approver is available in this mode. Adjust the permission rules or run interactively.`,
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
        return errorResult(describeDenial(name, target, answer))
      }
    }

    if (ctx.beforeExecute) {
      try {
        await ctx.beforeExecute()
      } catch {
      }
    }

    try {
      const outcome = await tool.execute(parsed.data, ctx)
      const settled = settle(outcome.output, ctx.settle)
      return {
        output: settled.text,
        isError: outcome.isError ?? false,
        truncated: settled.truncated,
        ...(outcome.meta !== undefined ? { meta: outcome.meta } : {}),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return errorResult(`Tool ${name} failed: ${message}`)
    }
  }
}
