import { homedir } from "node:os"
import { join, resolve } from "node:path"
import {
  AiSdkProvider,
  BG_TASKS_STATE_KEY,
  BgTaskRegistry,
  bashTool,
  buildSkeleton,
  buildSystem,
  CodeGraph,
  computeCostUSD,
  createExploreTool,
  createMcpTool,
  createMemoryTool,
  createModelResolver,
  createSkillTool,
  createSnapshot,
  createTaskTool,
  createWebTool,
  decideAttention,
  describeEvolution,
  describeVerification,
  EpisodicIndex,
  editTool,
  evolveAfterTurn,
  expandMentions,
  focusedSkeleton,
  formatUSD,
  frecencyStorePath,
  globTool,
  grepTool,
  listUntracked,
  loadConfig,
  loadMemory,
  McpHub,
  type ModelCost,
  ModelsCatalog,
  memoryPaths,
  moduleOverview,
  mutatingSubagentRegistry,
  OfflineMockProvider,
  OLLAMA_DEFAULT_BASE,
  type PermissionRules,
  type ProviderPort,
  parseModelRef,
  preloadHandoff,
  presetBaseURL,
  probeOllamaContext,
  type RunnerEvent,
  readTool,
  renderMentionBlock,
  runUserTurn,
  SessionJournal,
  servedContextWarning,
  skillsIndex,
  type TaskToolOptions,
  ToolRegistry,
  todoTool,
  verifyLatestTurn,
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
  /** Cheaper default model for subagents (subagent_model ?? small_model). */
  subagentModel?: () => string | undefined
  /** Pricing per model id — subagent spend is priced at its own model. */
  costFor?: (model: string) => ModelCost | undefined
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
    ...(deps.subagentModel ? { subagentModel: deps.subagentModel } : {}),
    ...(deps.costFor ? { costFor: deps.costFor } : {}),
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

export function applyResumeHandoff(
  cwd: string,
  taskText: string,
  resumeHandoff: boolean,
  notify?: (text: string) => void,
): string {
  if (!resumeHandoff) return taskText
  const preload = preloadHandoff(cwd, taskText)
  if (preload.notice) notify?.(preload.notice)
  return preload.taskText
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

export function renderEvent(event: RunnerEvent, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ event: event.type, ...event }))
    return
  }
  switch (event.type) {
    case "text-delta":
      process.stdout.write(event.text)
      break
    case "tool-call":
      process.stdout.write(`\n-> ${event.name} ${JSON.stringify(event.input).slice(0, 160)}\n`)
      break
    case "tool-result": {
      const head = event.output.split("\n", 2)[0] ?? ""
      process.stdout.write(`  ${event.isError ? "failed" : "ok"} ${head.slice(0, 160)}\n`)
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

  const codeGraph = CodeGraph.open(cwd)
  const sync = await codeGraph.sync().catch(() => ({ scanned: 0, skipped: 0, removed: 0 }))
  const graph = codeGraph.db
  const graphRefresh = () => codeGraph.fresh()
  /** Assigned once the catalog loads below; subagents only price lazily. */
  let costFor: (model: string) => ModelCost | undefined = () => undefined
  registry.register(createExploreTool({ db: () => graph, cwd, refresh: graphRefresh }))
  registry.register(
    createTaskTool(
      taskToolOptions({
        cwd,
        sessionsDir: join(cwd, ".butterfly", "sessions"),
        provider: () => provider,
        model: () => modelRef,
        subagentModel: () => config.subagent_model ?? config.small_model,
        costFor: (model) => costFor(model),
        extras: (sub) => {
          sub.register(createExploreTool({ db: () => graph, cwd, refresh: graphRefresh }))
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
  const overview = moduleOverview(graph)
  const mapBlock = [overview, skeleton].filter((part) => part !== "").join("\n\n")
  const withSkeleton =
    mapBlock === ""
      ? withMentions
      : `[repository map — modules + ranked symbols; explore op=map|outline|symbol|deps for more]\n${mapBlock}\n\n${withMentions}`
  const taskText = applyResumeHandoff(cwd, withSkeleton, opts.resumeHandoff ?? false, (text) => {
    if (!opts.json) process.stdout.write(`[handoff: ${text}]\n`)
  })
  if (!opts.json && (sync.scanned > 0 || sync.removed > 0)) {
    process.stdout.write(`[graph: ${sync.scanned} scanned, ${sync.skipped} cached]\n`)
  }

  // Best-effort model limits from the models.dev snapshot → auto-compaction.
  const catalog = await ModelsCatalog.load({
    cachePath: join(homedir(), ".config", "butterfly", "models-cache.json"),
  }).catch(() => ModelsCatalog.empty())
  const ref = parseModelRef(modelRef)
  const entry = catalog.lookup(ref.providerId, ref.modelId)
  costFor = (model) => {
    try {
      const parsed = parseModelRef(model)
      return catalog.lookup(parsed.providerId, parsed.modelId)?.cost
    } catch {
      return undefined
    }
  }
  // Summarization-class work (compaction, evolver): small_model, else a
  // catalog-derived cheap same-provider companion (auto_small_model).
  const autoSmall =
    config.small_model === undefined && config.auto_small_model !== false
      ? catalog.cheapCompanion(ref.providerId, ref.modelId)
      : undefined
  const summaryModel =
    config.small_model ?? (autoSmall ? `${ref.providerId}/${autoSmall}` : undefined)
  const smallModelCost = summaryModel ? costFor(summaryModel) : undefined
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

  const state: Record<string, unknown> = {}
  const bgTasks = new BgTaskRegistry({
    cwd,
    logDir: join(cwd, ".butterfly", "bg"),
    journal,
  })
  state[BG_TASKS_STATE_KEY] = bgTasks

  const stopExitClear = installProgressExitClear(process.stderr, () => {
    bgTasks.reap()
  })

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
        state,
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
        ...(smallModelCost ? { smallModelCost } : {}),
        codeMap: (files) => (graph ? focusedSkeleton(graph, files.join(" "), 400) : ""),
        ...((opts.maxSpendUSD ?? config.maxSpendUSD) !== undefined
          ? { maxSpendUSD: opts.maxSpendUSD ?? config.maxSpendUSD }
          : {}),
        ...(config.hooks?.length ? { hooks: config.hooks } : {}),
        ...(config.retries !== undefined ? { retries: config.retries } : {}),
        ...(config.autoContinue !== undefined ? { autoContinue: config.autoContinue } : {}),
        ...(entry ? { limits: { context: entry.context, output: entry.output } } : {}),
        imageInputSupported: entry?.imageInput === true,
        ...(summaryModel ? { smallModel: summaryModel } : {}),
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
    // A local server serving a smaller context than the prefix needs
    // truncates silently — say so (stderr: stdout stays the answer).
    if (ref.providerId === "ollama") {
      const served = await probeOllamaContext(
        config.providers?.["ollama"]?.baseURL ?? presetBaseURL("ollama") ?? OLLAMA_DEFAULT_BASE,
        ref.modelId,
      )
      const prefixTokens =
        Math.ceil(system.length / 4) + Math.ceil(JSON.stringify(registry.list()).length / 4)
      const warning =
        served === undefined ? undefined : servedContextWarning(ref.modelId, served, prefixTokens)
      if (warning) process.stderr.write(`\n[warning: ${warning}]\n`)
    }
    /** Turn spend incl. subagents/compaction, plus the evolver below. */
    let costUSD = outcome.costUSD
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
    // Leave graph.db + project-map.md matching the code this run produced.
    await codeGraph.sync().catch(() => {})
    if (config.memory?.autoReview !== false) {
      const evolved = await evolveAfterTurn({
        provider,
        model: summaryModel ?? modelRef,
        journal,
        paths,
        skillDir: join(cwd, ".butterfly", "skills"),
        skillDirs,
        autoSkills: config.memory?.autoSkills !== false,
        approval: config.memory?.approval === true,
      })
      const line = describeEvolution(evolved)
      if (line !== "" && !opts.json) process.stdout.write(`\n[${line}]`)
      const evolverCost = costFor(summaryModel ?? modelRef)
      if (evolverCost) costUSD += computeCostUSD(evolved.usage, evolverCost)
    }

    const verification = verifyLatestTurn(SessionJournal.replay(journal.path).events)
    const verifyLine = describeVerification(verification)
    if (opts.json) {
      console.log(JSON.stringify({ event: "done", ...summary, costUSD, verification }))
    } else {
      process.stdout.write(
        `${verifyLine !== "" ? `\n\n[${verifyLine}]` : ""}\n\n[${summary.steps} steps | in ${usage.input} out ${usage.output} cached ${usage.cacheRead}${costUSD > 0 ? ` | ${formatUSD(costUSD)}` : ""} | ${journal.path}]\n`,
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
    bgTasks.reap()
  }
}
