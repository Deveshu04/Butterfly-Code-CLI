import { z } from "zod"
import { type PermissionRules, resolvePermission } from "../../permission/tree"
import type { ProviderPort } from "../../provider/port"
import type { ModelCost } from "../../provider/pricing"
import type { Usage } from "../../session/events"
import type { ToolContext, ToolDefinition, ToolOutcome } from "../registry"
import { ToolRegistry } from "../registry"
import {
  createWorktree,
  discardWorktree,
  listWorktrees,
  MAX_CONCURRENT_WORKTREES,
  mergeWorktree,
  removeWorktree,
  worktreeStatus,
  writeWorktreeMeta,
} from "../worktree"
import { bashTool } from "./bash"
import { editTool } from "./edit"
import { globTool } from "./glob"
import { grepTool } from "./grep"
import { readTool } from "./read"

const isolationField = z
  .enum(["worktree"])
  .optional()
  .describe(
    "Run the subagent in an isolated git worktree with a MUTATING toolset (edit/bash included) — it cannot corrupt the main working tree. Requires a git repo. Its changes come back as a worktree id; review, then op=merge or op=discard.",
  )
const modelField = z
  .enum(["small", "main"])
  .optional()
  .describe(
    'Which model runs the subagent. "small" (default): the cheaper subagent_model/small_model — right for search, reading, routine edits, tests. "main": your own model, for subtasks that need real reasoning.',
  )

export const MAX_PARALLEL_TASKS = 6

export const taskInput = z.object({
  op: z
    .enum(["run", "merge", "discard", "list"])
    .optional()
    .describe(
      "run (default): spawn subagent(s). merge: apply a finished worktree's changes to the main working tree. discard: delete a worktree's changes. list: isolated worktrees awaiting merge/discard.",
    ),
  task: z.string().optional().describe("Self-contained instruction for ONE subagent"),
  isolation: isolationField,
  model: modelField,
  tasks: z
    .array(z.object({ task: z.string(), isolation: isolationField, model: modelField }))
    .min(1)
    .max(MAX_PARALLEL_TASKS)
    .optional()
    .describe(
      `Fan out up to ${MAX_PARALLEL_TASKS} INDEPENDENT subtasks that run IN PARALLEL, each in its own context (and own worktree if isolated). Use instead of 'task' whenever work splits into parts that don't depend on each other.`,
    ),
  worktree: z.string().optional().describe("op=merge|discard: the worktree id from a task report"),
})
type TaskInput = z.infer<typeof taskInput>
type Tier = "small" | "main"

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
  subagentModel?: () => string | undefined
  costFor?: (model: string) => ModelCost | undefined
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
  /** Priced at the subagent's own model; undefined when pricing is unknown. */
  costUSD?: number
}

export interface ToolSpend {
  usage: Usage
  costUSD?: number
}

function spendOf(result: SubagentTurnResult): ToolSpend {
  return {
    usage: result.usage,
    ...(result.costUSD !== undefined ? { costUSD: result.costUSD } : {}),
  }
}

/** Sum of every subtask's spend; costUSD only when all of them are priced. */
export function sumSpend(spends: (ToolSpend | undefined)[]): ToolSpend | undefined {
  const present = spends.filter((spend): spend is ToolSpend => spend !== undefined)
  if (present.length === 0) return undefined
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const spend of present) {
    usage.input += spend.usage.input
    usage.output += spend.usage.output
    usage.cacheRead += spend.usage.cacheRead
    usage.cacheWrite += spend.usage.cacheWrite
  }
  const priced = present.every((spend) => spend.costUSD !== undefined)
  return {
    usage,
    ...(priced ? { costUSD: present.reduce((sum, spend) => sum + (spend.costUSD ?? 0), 0) } : {}),
  }
}

export async function runSubagentTurn(
  opts: SubagentTurnOptions,
  promptText: string,
  signal?: AbortSignal,
  onStep?: (status: string) => void,
): Promise<SubagentTurnResult> {
  // Lazy import breaks the runner↔tool dependency cycle.
  const { runUserTurn } = await import("../../session/runner")
  const { SessionJournal } = await import("../../session/journal")

  const model = opts.model()
  const journal = SessionJournal.create(opts.sessionsDir)
  const cost = opts.costFor?.(model)
  const outcome = await runUserTurn(
    {
      ...(cost ? { cost } : {}),
      provider: opts.provider(),
      registry: opts.makeRegistry(),
      journal,
      rules: opts.rules ?? TASK_RULES,
      model,
      system: opts.system(model),
      cwd: opts.cwd,
      maxSteps: opts.maxSteps ?? TASK_MAX_STEPS,
      signal,
      ...(onStep ? { onEvent: stepReporter(onStep) } : {}),
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
    ...(cost ? { costUSD: outcome.costUSD } : {}),
  }
}

function stepReporter(onStep: (status: string) => void): (event: { type: string }) => void {
  let steps = 0
  let writing = false
  return (event) => {
    const e = event as { type: string; name?: string; input?: unknown; text?: string }
    if (e.type === "tool-call") {
      steps += 1
      writing = false
      const detail = JSON.stringify(e.input ?? {})
        .replace(/\s+/g, " ")
        .slice(0, 60)
      onStep(`step ${steps} - ${e.name ?? "tool"} ${detail}`)
    } else if (e.type === "text-delta" && !writing && (e.text ?? "").trim() !== "") {
      writing = true
      onStep(`step ${steps} - writing summary`)
    } else if (e.type === "notice" && typeof e.text === "string" && e.text.startsWith("retrying")) {
      onStep(`step ${steps} - ${e.text.slice(0, 60)}`)
    }
  }
}

async function gateWorktree(
  opts: TaskToolOptions,
  input: unknown,
  ctx: ToolContext,
  count: number,
): Promise<ToolOutcome | null> {
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
      note:
        count > 1
          ? `${count} isolated subagents in parallel, each with edit+bash inside its own disposable git worktree; the main working tree is never modified until you merge`
          : "isolated subagent with edit+bash inside a disposable git worktree; the main working tree is never modified",
      input,
    })
    if (answer !== "allow") {
      const who =
        answer === "deny"
          ? "User denied worktree isolation for this task."
          : `Worktree isolation was not approved — ${answer.reason}. The user never answered; do not treat this as their decision.`
      return {
        output: `${who} Do not retry this exact call; investigate read-only instead, or ask the user how to proceed.`,
        isError: true,
      }
    }
  }
  return null
}

interface Created {
  path: string
  baseSha: string
  mainTreeDirty: boolean
  id: string
}

/** Run one subagent inside an already-created worktree and report back. */
async function runInWorktree(
  opts: TaskToolOptions,
  created: Created,
  task: string,
  ctx: ToolContext,
  onStep?: (status: string) => void,
): Promise<ToolOutcome> {
  const subagentHeadNote = created.mainTreeDirty
    ? " NOTE: the main working tree currently has UNCOMMITTED changes that are NOT present here — this is a checkout of the last commit (HEAD) only, so some files may look older than what the user sees."
    : ""
  const parentHeadNote = created.mainTreeDirty
    ? "\n[worktree isolation: the main working tree had uncommitted changes when this worktree was created; the subagent worked from a HEAD-only checkout and did not see them.]"
    : ""

  const isolatedOpts: TaskToolOptions = {
    ...opts,
    cwd: created.path,
    makeRegistry: opts.makeMutatingRegistry ?? opts.makeRegistry,
    rules: mergeWorktreeRules(ctx.rules),
  }
  const prompt = `[isolated git worktree subagent — cwd: ${created.path}. This is a disposable checkout of the repo; editing files and running commands here is safe and does NOT affect the main working tree. Do the real work directly (edit/bash included). Do not commit.${subagentHeadNote}]\n\n${task}\n\nReply with a terse, information-dense summary of what you did (files changed, how you verified). Your reply is ALL the parent agent will see.`

  let result: SubagentTurnResult
  try {
    result = await runSubagentTurn(isolatedOpts, prompt, ctx.signal, onStep)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      output: `Worktree subagent failed: ${message}. The worktree was left in place for inspection (id ${created.id}).${parentHeadNote}`,
      isError: true,
      meta: { worktree: { id: created.id, path: created.path, dirty: true, cleaned: false } },
    }
  }

  const status = await worktreeStatus(created.path, created.baseSha)
  if (!status.dirty) {
    // Only a VERIFIED-clean worktree is ever force-removed (worktreeStatus
    // reports unknown as dirty), and the removal's own result is honored.
    const removed = await removeWorktree(opts.cwd, created.path)
    if (removed.ok) {
      return {
        output: `${result.summary}\n\n[worktree isolation: no changes were left — the isolated worktree was cleaned up automatically.]${parentHeadNote}`,
        meta: {
          journal: result.journalPath,
          spend: spendOf(result),
          worktree: { id: created.id, path: created.path, dirty: false, cleaned: true },
        },
      }
    }
    return {
      output: `${result.summary}\n\n[worktree isolation: no changes were left, but automatic cleanup FAILED (${removed.error}). The worktree is STILL on disk at ${created.path} and holds one of the ${MAX_CONCURRENT_WORKTREES} isolation slots — task op=discard worktree=${created.id}]${parentHeadNote}`,
      meta: {
        journal: result.journalPath,
        spend: spendOf(result),
        worktree: {
          id: created.id,
          path: created.path,
          dirty: false,
          cleaned: false,
          cleanupError: removed.error,
        },
      },
    }
  }

  const report = status.undetermined
    ? `[worktree isolation: worktree ${created.id} could NOT be verified as clean (${status.undetermined}), so it was LEFT IN PLACE at ${created.path} — nothing was removed. Inspect it, then task op=merge or op=discard worktree=${created.id}.]`
    : `[worktree isolation: ${status.changedFiles} changed file(s), ${status.commitsAhead} commit(s) in worktree ${created.id} (${created.path}) — NOT yet in the main tree. Review (read files under that path), then task op=merge worktree=${created.id} to apply, or op=discard.]`
  return {
    output: `${result.summary}\n\n${report}${parentHeadNote}`,
    meta: {
      journal: result.journalPath,
      spend: spendOf(result),
      worktree: {
        id: created.id,
        path: created.path,
        dirty: true,
        cleaned: false,
        ...(status.undetermined ? { undetermined: status.undetermined } : {}),
      },
    },
  }
}

async function createFor(
  opts: TaskToolOptions,
  task: string,
): Promise<Created | { error: string }> {
  const id = crypto.randomUUID()
  const created = await createWorktree(opts.cwd, id)
  if (!created.ok) return { error: created.error }
  writeWorktreeMeta(opts.cwd, id, {
    baseSha: created.baseSha,
    created: Date.now(),
    task: task.slice(0, 200),
  })
  return { path: created.path, baseSha: created.baseSha, mainTreeDirty: created.mainTreeDirty, id }
}

const READ_ONLY_SUFFIX =
  "\n\nYou are a read-only subagent. Investigate, then reply with a terse, information-dense summary (findings, exact paths/identifiers, conclusions). Your reply is ALL the parent agent will see."

function withTier(
  opts: TaskToolOptions,
  tier: Tier | undefined,
): { opts: TaskToolOptions; label: string } {
  const main = opts.model()
  const small = opts.subagentModel?.()
  const chosen = tier === "main" || !small ? main : small
  return { opts: { ...opts, model: () => chosen }, label: chosen }
}

async function runOne(
  opts: TaskToolOptions,
  sub: { task: string; isolation?: "worktree"; model?: Tier },
  ctx: ToolContext,
  created?: Created,
  onStep?: (status: string) => void,
): Promise<ToolOutcome> {
  const tiered = withTier(opts, sub.model).opts
  if (sub.isolation === "worktree") {
    if (!created) return { output: "no worktree available for this subtask", isError: true }
    return runInWorktree(tiered, created, sub.task, ctx, onStep)
  }
  const result = await runSubagentTurn(tiered, `${sub.task}${READ_ONLY_SUFFIX}`, ctx.signal, onStep)
  return { output: result.summary, meta: { journal: result.journalPath, spend: spendOf(result) } }
}

/** Bounded-concurrency map preserving order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i] as T, i)
    }
  })
  await Promise.all(workers)
  return out
}

async function runBatch(
  opts: TaskToolOptions,
  input: TaskInput,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const subs = input.tasks ?? []
  const isolated = subs.filter((sub) => sub.isolation === "worktree").length
  if (isolated > 0) {
    const refused = await gateWorktree(opts, input, ctx, isolated)
    if (refused) return refused
  }
  const created: (Created | { error: string } | undefined)[] = []
  for (const sub of subs) {
    created.push(sub.isolation === "worktree" ? await createFor(opts, sub.task) : undefined)
  }
  const status = subs.map(() => "queued")
  const report = () =>
    ctx.progress?.(status.map((line, i) => `[${i + 1}/${subs.length}] ${line}`).join("\n"))
  const outcomes = await mapLimit(subs, MAX_PARALLEL_TASKS, async (sub, i) => {
    const slot = created[i]
    if (slot && "error" in slot) return { output: slot.error, isError: true } as ToolOutcome
    const onStep = (line: string) => {
      status[i] = line
      report()
    }
    try {
      onStep("starting")
      const outcome = await runOne(opts, sub, ctx, slot, onStep)
      onStep(outcome.isError ? "failed" : "done")
      return outcome
    } catch (error) {
      onStep("failed")
      return {
        output: `subagent failed: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      }
    }
  })
  const sections = outcomes.map((outcome, i) => {
    const sub = subs[i]
    const tier = withTier(opts, sub?.model).label
    const brief = (sub?.task ?? "").replace(/\s+/g, " ").slice(0, 70)
    return `## [${i + 1}/${subs.length}] ${brief}${(sub?.task.length ?? 0) > 70 ? "…" : ""}\n(${tier}${sub?.isolation === "worktree" ? ", worktree" : ", read-only"}${outcome.isError ? ", FAILED" : ""})\n${outcome.output}`
  })
  const failed = outcomes.filter((o) => o.isError).length
  return {
    output: `${subs.length} subagents ran in parallel${failed > 0 ? ` (${failed} failed)` : ""}.\n\n${sections.join("\n\n")}`,
    isError: failed === subs.length,
    meta: {
      subtasks: outcomes.map((o) => o.meta ?? null),
      spend: sumSpend(outcomes.map((o) => (o.meta as { spend?: ToolSpend } | undefined)?.spend)),
    },
  }
}

async function listOp(opts: TaskToolOptions): Promise<ToolOutcome> {
  const worktrees = listWorktrees(opts.cwd)
  if (worktrees.length === 0)
    return { output: "No isolated worktrees are waiting for merge or discard." }
  const rows = await Promise.all(
    worktrees.map(async (w) => {
      const status = w.meta?.baseSha ? await worktreeStatus(w.path, w.meta.baseSha) : undefined
      const changes = status
        ? status.undetermined
          ? "status unknown"
          : `${status.changedFiles} changed, ${status.commitsAhead} commits`
        : "base unknown"
      return `${w.id}  ${changes}  ${w.meta?.task ? `— ${w.meta.task.slice(0, 80)}` : ""}`
    }),
  )
  return {
    output: `isolated worktrees (${rows.length}/${MAX_CONCURRENT_WORKTREES} slots):\n${rows.join("\n")}`,
  }
}

async function mergeOp(
  opts: TaskToolOptions,
  input: TaskInput,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  if (!input.worktree) return { output: "op=merge needs worktree=<id>.", isError: true }
  // Merging writes the main working tree — exactly an edit, so it obeys the
  // session's edit rule (plan mode denies; interactive defaults ask).
  const decision = resolvePermission(ctx.rules, "edit", undefined)
  if (decision === "deny") {
    return {
      output: "Merging is refused: edits are denied in this session (e.g. plan mode).",
      isError: true,
    }
  }
  if (decision === "ask") {
    if (!ctx.ask)
      return { output: "Merging needs approval but no approver is available.", isError: true }
    const answer = await ctx.ask({
      tool: "task",
      target: "merge",
      note: `apply worktree ${input.worktree}'s changes to the main working tree (as unstaged changes)`,
      input,
    })
    if (answer !== "allow") {
      return {
        output: "Merge was not approved — the worktree is untouched. Ask the user how to proceed.",
        isError: true,
      }
    }
  }
  const merged = await mergeWorktree(opts.cwd, input.worktree)
  if (!merged.ok) return { output: merged.error, isError: true }
  if (merged.files.length === 0) return { output: "The worktree had no changes; it was removed." }
  return {
    output: `Merged ${merged.files.length} file(s) into the main working tree (unstaged): ${merged.files.join(", ")}.${merged.removed ? " The worktree was removed." : " The worktree could not be removed — discard it later."} Run the project's checks before finishing.`,
    meta: { merged: merged.files, patch: merged.patchPath },
  }
}

export function createTaskTool(opts: TaskToolOptions): ToolDefinition<TaskInput> {
  return {
    name: "task",
    description:
      'Delegate to isolated subagents (own context; only short summaries come back). task="…" runs one; tasks=[…] runs up to 6 INDEPENDENT subtasks in PARALLEL — prefer it whenever work splits. Default is read-only investigation on the cheap model; model:"main" for hard reasoning. isolation:"worktree" gives a subagent edit/bash inside its own git worktree; afterwards review and op=merge worktree=<id> (or op=discard). op=list shows pending worktrees.',
    inputSchema: taskInput,
    permissionTarget: (input) =>
      input.op === "merge"
        ? "merge"
        : input.isolation === "worktree" || input.tasks?.some((t) => t.isolation === "worktree")
          ? "worktree"
          : undefined,
    async execute(input, ctx) {
      const op = input.op ?? "run"
      if (op === "list") return listOp(opts)
      if (op === "merge") return mergeOp(opts, input, ctx)
      if (op === "discard") {
        if (!input.worktree) return { output: "op=discard needs worktree=<id>.", isError: true }
        const removed = await discardWorktree(opts.cwd, input.worktree)
        return removed.ok
          ? { output: `Discarded worktree ${input.worktree}.` }
          : { output: removed.error, isError: true }
      }
      if (input.tasks && input.tasks.length > 0) return runBatch(opts, input, ctx)
      if (!input.task)
        return { output: "task needs `task` (one subagent) or `tasks` (parallel).", isError: true }
      if (input.isolation === "worktree") {
        const refused = await gateWorktree(opts, input, ctx, 1)
        if (refused) return refused
        const created = await createFor(opts, input.task)
        if ("error" in created) return { output: created.error, isError: true }
        return runOne(
          opts,
          { task: input.task, isolation: "worktree", model: input.model },
          ctx,
          created,
          ctx.progress,
        )
      }
      return runOne(opts, { task: input.task, model: input.model }, ctx, undefined, ctx.progress)
    },
  }
}
