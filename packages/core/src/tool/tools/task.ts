import { z } from "zod"
import { type PermissionRules, resolvePermission } from "../../permission/tree"
import type { ProviderPort } from "../../provider/port"
import type { Usage } from "../../session/events"
import type { ToolContext, ToolDefinition, ToolOutcome } from "../registry"
import { ToolRegistry } from "../registry"
import {
  createWorktree,
  MAX_CONCURRENT_WORKTREES,
  removeWorktree,
  worktreeStatus,
} from "../worktree"
import { bashTool } from "./bash"
import { editTool } from "./edit"
import { globTool } from "./glob"
import { grepTool } from "./grep"
import { readTool } from "./read"

export const taskInput = z.object({
  task: z.string().describe("Self-contained instruction for the subagent"),
  isolation: z
    .enum(["worktree"])
    .optional()
    .describe(
      "Run the subagent in an isolated git worktree with a MUTATING toolset (edit/bash included, not just read-only) — it cannot corrupt the main working tree. Requires a git repo. Changes are reported back with the worktree path, never auto-merged.",
    ),
})

export const TASK_SUMMARY_CAP = 2_000
export const TASK_MAX_STEPS = 15

export const TASK_RULES: PermissionRules = {
  "*": "allow",
  edit: "deny",
  bash: "deny",
  memory: "deny",
}

export const WORKTREE_RULES: PermissionRules = {
  "*": "allow",
  edit: { "*": "allow", "**/.env*": "deny", ".env*": "deny" },
}

export function mergeWorktreeRules(session: PermissionRules): PermissionRules {
  const merged: PermissionRules = {}
  for (const [tool, entry] of Object.entries(WORKTREE_RULES)) {
    merged[tool] = typeof entry === "string" ? entry : { ...entry }
  }
  for (const [tool, entry] of Object.entries(session)) {
    if (tool === "*") continue
    if (typeof entry === "string") {
      if (entry === "deny") merged[tool] = "deny"
      continue
    }
    const denies = Object.entries(entry).filter(([, decision]) => decision === "deny")
    if (denies.length === 0) continue
    const base = merged[tool]
    if (base === "deny") continue
    merged[tool] =
      typeof base === "string"
        ? { "*": base, ...Object.fromEntries(denies) }
        : { ...(base ?? {}), ...Object.fromEntries(denies) }
  }
  return merged
}

export function mutatingSubagentRegistry(extras?: (registry: ToolRegistry) => void): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(readTool)
  registry.register(globTool)
  registry.register(grepTool)
  registry.register(editTool)
  registry.register(bashTool)
  extras?.(registry)
  return registry
}

export interface TaskToolOptions {
  provider: () => ProviderPort
  model: () => string
  system: (model: string) => string
  cwd: string
  sessionsDir: string
  /** Registry for the subagent — must NOT contain the task tool (no recursion). */
  makeRegistry: () => ToolRegistry
  makeMutatingRegistry?: () => ToolRegistry
  rules?: PermissionRules
  maxSteps?: number
}

/** Reusable by any caller that spawns an isolated subagent (task tool, /review). */
export type SubagentTurnOptions = TaskToolOptions

export interface SubagentTurnResult {
  /** Already capped to TASK_SUMMARY_CAP chars, with a trailing usage note. */
  summary: string
  journalPath: string
  steps: number
  usage: Usage
}

export async function runSubagentTurn(
  opts: SubagentTurnOptions,
  promptText: string,
  signal?: AbortSignal,
): Promise<SubagentTurnResult> {
  // Lazy import breaks the runner↔tool dependency cycle.
  const { runUserTurn } = await import("../../session/runner")
  const { SessionJournal } = await import("../../session/journal")

  const model = opts.model()
  const journal = SessionJournal.create(opts.sessionsDir)
  const outcome = await runUserTurn(
    {
      provider: opts.provider(),
      registry: opts.makeRegistry(),
      journal,
      rules: opts.rules ?? TASK_RULES,
      model,
      system: opts.system(model),
      cwd: opts.cwd,
      maxSteps: opts.maxSteps ?? TASK_MAX_STEPS,
      signal,
    },
    promptText,
  )

  const summary = outcome.text.trim() || "(subagent produced no summary)"
  const note = ` [subagent: ${outcome.steps} steps, ${outcome.usage.input + outcome.usage.output} tokens]`
  return {
    summary: `${summary.slice(0, TASK_SUMMARY_CAP)}${note}`,
    journalPath: journal.path,
    steps: outcome.steps,
    usage: outcome.usage,
  }
}

async function executeWorktreeTask(
  opts: TaskToolOptions,
  input: z.infer<typeof taskInput>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const editDecision = resolvePermission(ctx.rules, "edit", undefined)
  const bashDecision = resolvePermission(ctx.rules, "bash", undefined)
  if (editDecision === "deny" || bashDecision === "deny") {
    return {
      output:
        "Worktree isolation refused by permission policy: edit and/or bash are denied outright in this session (e.g. plan mode), and isolation requires a mutating toolset. Do not retry this exact call.",
      isError: true,
    }
  }

  if (!opts.makeMutatingRegistry) {
    return {
      output:
        "Worktree isolation is not configured for this session (no mutating registry available). Retry without isolation, or investigate read-only.",
      isError: true,
    }
  }

  if (editDecision === "ask" || bashDecision === "ask") {
    if (!ctx.ask) {
      return {
        output:
          "Worktree isolation requires approval in this session (edit and/or bash are set to ask), but no approver is available in this mode. Adjust the permission rules or run interactively. Retry without isolation to investigate read-only.",
        isError: true,
      }
    }
    const answer = await ctx.ask({
      tool: "task",
      target: "worktree",
      note: "isolated subagent with edit+bash inside a disposable git worktree; the main working tree is never modified",
      input,
    })
    if (answer !== "allow") {
      return {
        output:
          "User denied worktree isolation for this task. Do not retry this exact call; investigate read-only instead, or ask the user how to proceed.",
        isError: true,
      }
    }
  }

  const taskId = crypto.randomUUID()
  const created = await createWorktree(opts.cwd, taskId)
  if (!created.ok) {
    return { output: created.error, isError: true }
  }

  const subagentHeadNote = created.mainTreeDirty
    ? " NOTE: the main working tree currently has UNCOMMITTED changes that are NOT present here — this is a checkout of the last commit (HEAD) only, so some files may look older than what the user sees."
    : ""
  const parentHeadNote = created.mainTreeDirty
    ? "\n[worktree isolation: the main working tree had uncommitted changes when this worktree was created; the subagent worked from a HEAD-only checkout and did not see them.]"
    : ""

  const isolatedOpts: TaskToolOptions = {
    ...opts,
    cwd: created.path,
    makeRegistry: opts.makeMutatingRegistry,
    rules: mergeWorktreeRules(ctx.rules),
  }
  const prompt = `[isolated git worktree subagent — cwd: ${created.path}. This is a disposable checkout of the repo; editing files and running commands here is safe and does NOT affect the main working tree. Do the real work directly (edit/bash included).${subagentHeadNote}]\n\n${input.task}\n\nReply with a terse, information-dense summary of what you did. Your reply is ALL the parent agent will see.`

  let result: SubagentTurnResult
  try {
    result = await runSubagentTurn(isolatedOpts, prompt, ctx.signal)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      output: `Worktree subagent failed: ${message}. The worktree was left in place for inspection at ${created.path}.${parentHeadNote}`,
      isError: true,
      meta: { worktree: { path: created.path, dirty: true, cleaned: false } },
    }
  }

  const status = await worktreeStatus(created.path, created.baseSha)
  if (!status.dirty) {
    const removed = await removeWorktree(opts.cwd, created.path)
    if (removed.ok) {
      return {
        output: `${result.summary}\n\n[worktree isolation: no changes were left — the isolated worktree at ${created.path} was cleaned up automatically.]${parentHeadNote}`,
        meta: {
          journal: result.journalPath,
          worktree: { path: created.path, dirty: false, cleaned: true },
        },
      }
    }
    return {
      output: `${result.summary}\n\n[worktree isolation: no changes were left, but automatic cleanup FAILED (${removed.error}). The worktree is STILL on disk at ${created.path} and holds one of the ${MAX_CONCURRENT_WORKTREES} isolation slots — remove it manually: git worktree remove --force "${created.path}"]${parentHeadNote}`,
      meta: {
        journal: result.journalPath,
        worktree: {
          path: created.path,
          dirty: false,
          cleaned: false,
          cleanupError: removed.error,
        },
      },
    }
  }

  const report = status.undetermined
    ? `[worktree isolation: the worktree at ${created.path} could NOT be verified as clean (${status.undetermined}), so it was LEFT IN PLACE — nothing was removed, no work can have been lost. Inspect it, then merge or remove it manually.]`
    : `[worktree isolation: changes are at ${created.path} (${status.changedFiles} changed file(s), ${status.commitsAhead} commit(s) ahead of the base) — NOT merged into the main working tree. Review and merge manually, or remove the worktree to discard.]`
  return {
    output: `${result.summary}\n\n${report}${parentHeadNote}`,
    meta: {
      journal: result.journalPath,
      worktree: {
        path: created.path,
        dirty: true,
        cleaned: false,
        ...(status.undetermined ? { undetermined: status.undetermined } : {}),
      },
    },
  }
}

export function createTaskTool(opts: TaskToolOptions): ToolDefinition<z.infer<typeof taskInput>> {
  return {
    name: "task",
    description:
      'Delegate a self-contained task to an isolated subagent (own context; only its short summary comes back). Default is read-only investigation. isolation:"worktree" instead gives it a mutating toolset (edit/bash) inside a disposable git worktree, so it can make real changes without risking the main working tree — completion is reported (path + diff stat), never auto-merged.',
    inputSchema: taskInput,
    permissionTarget: (input) => (input.isolation === "worktree" ? "worktree" : undefined),
    async execute(input, ctx) {
      if (input.isolation === "worktree") {
        return executeWorktreeTask(opts, input, ctx)
      }
      const result = await runSubagentTurn(
        opts,
        `${input.task}\n\nYou are a read-only subagent. Investigate, then reply with a terse, information-dense summary (findings, exact paths/identifiers, conclusions). Your reply is ALL the parent agent will see.`,
        ctx.signal,
      )
      return { output: result.summary, meta: { journal: result.journalPath } }
    },
  }
}
