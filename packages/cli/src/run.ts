import { homedir } from "node:os"
import { join, resolve } from "node:path"
import {
  AiSdkProvider,
  bashTool,
  buildSkeleton,
  buildSystem,
  consumeHandoff,
  createExploreTool,
  createMcpTool,
  createMemoryTool,
  createModelResolver,
  createSkillTool,
  createSnapshot,
  createTaskTool,
  createWebTool,
  decideAttention,
  EpisodicIndex,
  editTool,
  expandMentions,
  formatUSD,
  frecencyStorePath,
  GraphDb,
  globTool,
  grepTool,
  listUntracked,
  loadConfig,
  loadMemory,
  McpHub,
  ModelsCatalog,
  memoryPaths,
  mutatingSubagentRegistry,
  OfflineMockProvider,
  type PermissionRules,
  type ProviderPort,
  parseModelRef,
  type RunnerEvent,
  readTool,
  renderHandoffPreload,
  renderMentionBlock,
  reviewTurn,
  runUserTurn,
  SessionJournal,
  skillsIndex,
  syncRepo,
  type TaskToolOptions,
  ToolRegistry,
  todoTool,
  withFrecencyTouch,
} from "@butterfly/core"
import { applyHeadlessAttention, installProgressExitClear } from "./attention-headless"

export interface RunOptions {
  task: string
  model?: string
  budget?: number
  maxSpendUSD?: number
  cwd?: string
  json: boolean
  maxSteps?: number
  /** Preload `.butterfly/handoff.md` (if any) into this run's first turn, then consume it. */
  resumeHandoff?: boolean
}

/** Headless default: act freely in the workspace, but never touch env files. */
const HEADLESS_DEFAULT_RULES: PermissionRules = {
  "*": "allow",
  edit: { "**/.env*": "deny", ".env*": "deny" },
}

export function taskToolOptions(deps: {
  cwd: string
  sessionsDir: string
  provider: () => ProviderPort
  model: () => string
  extras: (registry: ToolRegistry) => void
}): TaskToolOptions {
  const system = (model: string) =>
    buildSystem(model, {
      cwd: deps.cwd,
      platform: process.platform,
      date: new Date().toISOString().slice(0, 10),
    })
  return {
    provider: deps.provider,
    model: deps.model,
    system,
    cwd: deps.cwd,
    sessionsDir: deps.sessionsDir,
    makeRegistry: () => {
      const sub = new ToolRegistry()
      sub.register(readTool)
      sub.register(globTool)
      sub.register(grepTool)
      deps.extras(sub)
      return sub
    },
    // isolation:"worktree" — mutating toolset, rooted at the worktree cwd.
    makeMutatingRegistry: () => mutatingSubagentRegistry(deps.extras),
  }
}

export function applyResumeHandoff(cwd: string, taskText: string, resumeHandoff: boolean): string {
  if (!resumeHandoff) return taskText
  const pending = consumeHandoff(cwd)
  return pending ? `${renderHandoffPreload(pending)}\n\n${taskText}` : taskText
}

function makeRegistry(cwd: string): ToolRegistry {
  const registry = new ToolRegistry()
  const frecencyStore = frecencyStorePath(cwd)
  registry.register(bashTool)
  registry.register(withFrecencyTouch(readTool, frecencyStore, (input) => input.file_path))
  registry.register(withFrecencyTouch(editTool, frecencyStore, (input) => input.file_path))
  registry.register(globTool)
  registry.register(grepTool)
  registry.register(todoTool)
  return registry
}

function renderEvent(event: RunnerEvent, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ event: event.type, ...event }))
    return
  }
  switch (event.type) {
    case "text-delta":
      process.stdout.write(event.text)
      break
    case "tool-call":
      process.stdout.write(`\n→ ${event.name} ${JSON.stringify(event.input).slice(0, 160)}\n`)
      break
    case "tool-result": {
      const head = event.output.split("\n", 2)[0] ?? ""
      process.stdout.write(`  ${event.isError ? "✗" : "✓"} ${head.slice(0, 160)}\n`)
      break
    }
    default:
      break
  }
}

export async function runHeadless(opts: RunOptions): Promise<number> {
  const cwd = resolve(opts.cwd ?? process.cwd())
  const config = loadConfig({ cwd })
  const modelRef = opts.model ?? config.model
  if (!modelRef) {
    console.error(
      'No model configured. Pass --model provider/model (e.g. --model "ollama/qwen3:8b") or set "model" in butterfly.jsonc.',
    )
    return 1
  }

  const registry = makeRegistry(cwd)
  const journal = SessionJournal.create(join(cwd, ".butterfly", "sessions"))
  const provider = modelRef.startsWith("mock/")
    ? new OfflineMockProvider()
    : new AiSdkProvider(createModelResolver(config))

  const home = homedir()
  const paths = memoryPaths(cwd, home)
  const memory = loadMemory(paths)
  const skillDirs = [
    join(cwd, ".butterfly", "skills"),
    join(home, ".config", "butterfly", "skills"),
  ]
  const episodic = EpisodicIndex.open(join(cwd, ".butterfly", "index.db"))
  try {
    for (const file of new Bun.Glob("*.jsonl").scanSync({
      cwd: join(cwd, ".butterfly", "sessions"),
      onlyFiles: true,
    })) {
      try {
        episodic.indexJournal(join(cwd, ".butterfly", "sessions", file))
      } catch {
        // stale/corrupt journals must not block a run
      }
    }
  } catch {
    // no sessions dir yet
  }
  registry.register(createMemoryTool({ paths, episodic: () => episodic }))
  registry.register(createSkillTool({ dirs: skillDirs }))
  registry.register(createWebTool({ config: () => config.web }))

  // MCP: headless waits for connection so the mcp tool is ready turn 1.
  let mcpHub: McpHub | undefined
  registry.register(createMcpTool({ hub: () => mcpHub }))
  if (config.mcp && Object.keys(config.mcp).length > 0) {
    mcpHub = await McpHub.connect(config.mcp).catch(() => undefined)
  }

  const graph = GraphDb.open(join(cwd, ".butterfly", "graph.db"))
  const sync = await syncRepo(cwd, graph)
  registry.register(createExploreTool({ db: () => graph, cwd }))
  registry.register(
    createTaskTool(
      taskToolOptions({
        cwd,
        sessionsDir: join(cwd, ".butterfly", "sessions"),
        provider: () => provider,
        model: () => modelRef,
        extras: (sub) => {
          sub.register(createExploreTool({ db: () => graph, cwd }))
          sub.register(createWebTool({ config: () => config.web }))
        },
      }),
    ),
  )
  const mentions = expandMentions(cwd, opts.task)
  const mentionBlock = renderMentionBlock(mentions)
  const mentioned = opts.task.split(/[^A-Za-z0-9_]+/).filter((word) => word.length >= 3)
  const skeleton = buildSkeleton(graph, {
    mentionedIdents: mentioned,
    chatFiles: mentions.map((m) => m.path),
  })
  const withMentions = mentionBlock === "" ? opts.task : `${mentionBlock}\n\n${opts.task}`
  const withSkeleton =
    skeleton === ""
      ? withMentions
      : `[repository map — ranked symbols; use explore/read for bodies]\n${skeleton}\n\n${withMentions}`
  const taskText = applyResumeHandoff(cwd, withSkeleton, opts.resumeHandoff ?? false)
  if (!opts.json && (sync.scanned > 0 || sync.removed > 0)) {
    process.stdout.write(`[graph: ${sync.scanned} scanned, ${sync.skipped} cached]\n`)
  }

  // Best-effort model limits from the models.dev snapshot → auto-compaction.
  const catalog = await ModelsCatalog.load({
    cachePath: join(homedir(), ".config", "butterfly", "models-cache.json"),
  }).catch(() => ModelsCatalog.empty())
  const ref = parseModelRef(modelRef)
  const entry = catalog.lookup(ref.providerId, ref.modelId)
  const system = buildSystem(modelRef, {
    cwd,
    platform: process.platform,
    date: new Date().toISOString().slice(0, 10),
    projectMemory: memory.project,
    userMemory: memory.user,
    skillsIndex: skillsIndex(skillDirs),
  })

  const notifications = config.notifications ?? true
  const attentionState = { focus: "blurred" as const, cwd }
  const attentionConfig = { notifications }
  applyHeadlessAttention(decideAttention({ kind: "turn.start" }, attentionState, attentionConfig))
  const stopExitClear = installProgressExitClear()

  let turnDetail: string | undefined
  try {
    const outcome = await runUserTurn(
      {
        provider,
        registry,
        journal,
        rules: config.permissions ?? HEADLESS_DEFAULT_RULES,
        model: modelRef,
        system,
        cwd,
        ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
        ...(opts.budget !== undefined ? { budgetTokens: opts.budget } : {}),
        createSnapshot,
        listUntracked,
        ...(entry?.cost
          ? {
              cost: {
                input: entry.cost.input,
                output: entry.cost.output,
                cacheRead: entry.cost.cacheRead,
                cacheWrite: entry.cost.cacheWrite,
              },
            }
          : {}),
        ...((opts.maxSpendUSD ?? config.maxSpendUSD) !== undefined
          ? { maxSpendUSD: opts.maxSpendUSD ?? config.maxSpendUSD }
          : {}),
        ...(config.hooks?.length ? { hooks: config.hooks } : {}),
        ...(entry ? { limits: { context: entry.context, output: entry.output } } : {}),
        imageInputSupported: entry?.imageInput === true,
        ...(config.small_model ? { smallModel: config.small_model } : {}),
        onEvent: (event) => {
          renderEvent(event, opts.json)
          if (event.type === "finish" && opts.budget !== undefined) {
            const percent = ((event.usage.input + event.usage.output) / opts.budget) * 100
            applyHeadlessAttention(
              decideAttention({ kind: "turn.progress", percent }, attentionState, attentionConfig),
            )
          }
        },
      },
      taskText,
    )

    const { usage } = outcome
    const summary = {
      steps: outcome.steps,
      tokens: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead },
      budgetExceeded: outcome.budgetExceeded,
      journal: journal.path,
    }
    if (outcome.budgetExceeded) turnDetail = "budget exceeded"
    // Post-turn upkeep: index this session; cheap-model memory review.
    try {
      episodic.indexJournal(journal.path)
    } catch {
      // non-fatal
    }
    if (config.small_model) {
      await reviewTurn({
        provider,
        model: config.small_model,
        journal,
        paths,
      })
    }

    if (opts.json) {
      console.log(JSON.stringify({ event: "done", ...summary }))
    } else {
      process.stdout.write(
        `\n\n[${summary.steps} steps | in ${usage.input} out ${usage.output} cached ${usage.cacheRead}${outcome.costUSD > 0 ? ` | ${formatUSD(outcome.costUSD)}` : ""} | ${journal.path}]\n`,
      )
    }
    return outcome.budgetExceeded ? 124 : 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    turnDetail = message
    if (opts.json) console.log(JSON.stringify({ event: "error", message }))
    else console.error(`\nError: ${message}`)
    return 1
  } finally {
    applyHeadlessAttention(
      decideAttention({ kind: "turn.end", detail: turnDetail }, attentionState, attentionConfig),
    )
    stopExitClear()
  }
}
