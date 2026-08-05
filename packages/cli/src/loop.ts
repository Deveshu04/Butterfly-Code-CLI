import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import {
  AiSdkProvider,
  bashTool,
  buildSystem,
  createExploreTool,
  createMemoryTool,
  createModelResolver,
  createSkillTool,
  createWebTool,
  decideAttention,
  EpisodicIndex,
  editTool,
  type Gate,
  GraphDb,
  globTool,
  grepTool,
  loadConfig,
  loadMemory,
  memoryPaths,
  type PermissionRules,
  readTool,
  runCommand,
  runLoop,
  runUserTurn,
  SessionJournal,
  skillsIndex,
  syncRepo,
  ToolRegistry,
  todoTool,
  WorkQueue,
} from "@butterfly/core"
import { applyHeadlessAttention, installProgressExitClear } from "./attention-headless"

const PLANNER_PROMPT = `You are the planning stage of an autonomous coding loop. Break the specification into 2-10 SMALL, independently verifiable tasks. Each task must be completable in one focused session and checkable by the project's test/build gates.

Reply with ONLY a JSON array, no prose:
[{"title":"short imperative title","spec":"exact, self-contained instructions","blockedBy":[0]}]
"blockedBy" lists 0-based indexes of tasks that must finish first. Prefer independent tasks; add dependencies only when strictly required. Implement nothing yourself.`

/** Loop state lives beside the repo's other runtime state. */
function loopPaths(cwd: string) {
  return {
    queue: join(cwd, ".butterfly", "queue.db"),
    handoff: join(cwd, ".butterfly", "handoff.json"),
    sessions: join(cwd, ".butterfly", "sessions"),
  }
}

const LOOP_RULES: PermissionRules = {
  "*": "allow",
  edit: { "**/.env*": "deny", ".env*": "deny" },
}

export async function runLoopCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      model: { type: "string" },
      budget: { type: "string" },
      "max-iterations": { type: "string" },
      file: { type: "string" },
      cwd: { type: "string" },
      "allow-dirty": { type: "boolean", default: false },
    },
  })
  const cwd = resolve(values.cwd ?? process.cwd())
  const config = loadConfig({ cwd })
  const paths = loopPaths(cwd)

  switch (sub) {
    case "plan": {
      const spec = values.file ? readFileSync(values.file, "utf8") : positionals.join(" ")
      if (spec.trim() === "") {
        console.error('Usage: butterfly loop plan "<spec>" | --file spec.md')
        return 1
      }
      const modelRef = values.model ?? config.model
      if (!modelRef) {
        console.error("No model configured (pass --model or set model in butterfly.jsonc).")
        return 1
      }
      const provider = new AiSdkProvider(createModelResolver(config))
      const registry = new ToolRegistry()
      const journal = SessionJournal.create(paths.sessions)
      const outcome = await runUserTurn(
        {
          provider,
          registry,
          journal,
          rules: { "*": "deny" },
          model: modelRef,
          system: PLANNER_PROMPT,
          cwd,
          maxSteps: 1,
        },
        spec,
      )
      const start = outcome.text.indexOf("[")
      const end = outcome.text.lastIndexOf("]")
      if (start < 0 || end <= start) {
        console.error(`Planner did not return JSON. Output was:\n${outcome.text}`)
        return 1
      }
      let tasks: { title: string; spec: string; blockedBy?: number[] }[]
      try {
        tasks = JSON.parse(outcome.text.slice(start, end + 1))
      } catch (error) {
        console.error(`Planner JSON parse failed: ${String(error)}\n${outcome.text}`)
        return 1
      }
      const queue = WorkQueue.open(paths.queue)
      const ids: string[] = []
      for (const task of tasks) {
        const blockedBy = (task.blockedBy ?? [])
          .map((index) => ids[index])
          .filter((id): id is string => id !== undefined)
        ids.push(queue.addTask({ title: task.title, spec: task.spec, blockedBy }))
      }
      const counts = queue.counts()
      queue.closeDb()
      console.log(`Planned ${ids.length} task(s). Queue: ${JSON.stringify(counts)}`)
      for (const [index, task] of tasks.entries()) {
        console.log(
          `  ${ids[index]}  ${task.title}${task.blockedBy?.length ? `  (after ${task.blockedBy.map((i) => ids[i]).join(", ")})` : ""}`,
        )
      }
      return 0
    }

    case "run": {
      const modelRef = values.model ?? config.model
      if (!modelRef) {
        console.error("No model configured (pass --model or set model in butterfly.jsonc).")
        return 1
      }
      const dirty = await runCommand("git status --porcelain", { cwd })
      const dirtyLines = dirty.stdout
        .split("\n")
        .filter((line) => line.trim() !== "" && !line.slice(3).startsWith(".butterfly/"))
      if (dirty.exitCode === 0 && dirtyLines.length > 0 && !values["allow-dirty"]) {
        console.error(
          "Working tree is dirty. Commit or stash first (the loop commits on every green gate), or pass --allow-dirty.",
        )
        return 1
      }
      const gates: Gate[] = config.gates ?? []
      if (gates.length === 0) {
        console.error(
          'No gates configured — refusing to loop blind. Add e.g. "gates": [{"name":"test","command":"bun test"}] to butterfly.jsonc.',
        )
        return 1
      }

      // Shared session services; fresh registry per iteration.
      const home = homedir()
      const memory = loadMemory(memoryPaths(cwd, home))
      const skillDirs = [
        join(cwd, ".butterfly", "skills"),
        join(home, ".config", "butterfly", "skills"),
      ]
      const graph = GraphDb.open(join(cwd, ".butterfly", "graph.db"))
      await syncRepo(cwd, graph)
      const episodic = EpisodicIndex.open(join(cwd, ".butterfly", "index.db"))
      const provider = new AiSdkProvider(createModelResolver(config))
      const system = buildSystem(modelRef, {
        cwd,
        platform: process.platform,
        date: new Date().toISOString().slice(0, 10),
        projectMemory: memory.project,
        userMemory: memory.user,
        skillsIndex: skillsIndex(skillDirs),
      })
      const makeRegistry = () => {
        const registry = new ToolRegistry()
        registry.register(bashTool)
        registry.register(readTool)
        registry.register(editTool)
        registry.register(globTool)
        registry.register(grepTool)
        registry.register(todoTool)
        registry.register(createExploreTool({ db: () => graph, cwd }))
        registry.register(
          createMemoryTool({ paths: memoryPaths(cwd, home), episodic: () => episodic }),
        )
        registry.register(createSkillTool({ dirs: skillDirs }))
        registry.register(createWebTool({ config: () => config.web }))
        return registry
      }

      const notifications = config.notifications ?? true
      const attentionState = { focus: "blurred" as const, cwd }
      const attentionConfig = { notifications }
      applyHeadlessAttention(
        decideAttention({ kind: "turn.start" }, attentionState, attentionConfig),
      )
      // Backstop for the paths no `finally` can reach: a signal, or a crash
      // that never unwinds. Uninstalled below once turn.end has run.
      const stopExitClear = installProgressExitClear()

      let loopDetail: string | undefined
      try {
        const queue = WorkQueue.open(paths.queue)
        let outcome: Awaited<ReturnType<typeof runLoop>>
        try {
          outcome = await runLoop({
            queue,
            provider,
            makeRegistry,
            rules: config.permissions ?? LOOP_RULES,
            model: modelRef,
            system,
            cwd,
            gates,
            ...(values.budget ? { budgetTokens: Number(values.budget) } : {}),
            ...(values["max-iterations"]
              ? { maxIterations: Number(values["max-iterations"]) }
              : {}),
            sessionsDir: paths.sessions,
            handoffPath: paths.handoff,
            ...(config.small_model ? { smallModel: config.small_model } : {}),
            onEvent: (message) => console.log(message),
          })
        } finally {
          queue.closeDb()
        }

        console.log(
          `\nLoop stopped (${outcome.stopReason}): ${outcome.closed} closed, ${outcome.blocked} blocked, ${outcome.iterations} iterations, ${outcome.usage.input + outcome.usage.output} tokens.`,
        )
        loopDetail = `${outcome.stopReason}: ${outcome.closed} closed, ${outcome.blocked} blocked`
        if (outcome.stopReason === "drained") return 0
        if (outcome.stopReason === "budget" || outcome.stopReason === "max-iterations") return 124
        return 1
      } catch (error) {
        loopDetail = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        applyHeadlessAttention(
          decideAttention(
            { kind: "turn.end", detail: loopDetail },
            attentionState,
            attentionConfig,
          ),
        )
        stopExitClear()
      }
    }

    case "status": {
      const queue = WorkQueue.open(paths.queue)
      console.log(JSON.stringify(queue.counts()))
      for (const task of queue.ready()) console.log(`ready: ${task.id}  ${task.title}`)
      queue.closeDb()
      try {
        console.log(`handoff: ${readFileSync(paths.handoff, "utf8")}`)
      } catch {
        // no handoff yet
      }
      return 0
    }

    default:
      console.error("Usage: butterfly loop plan|run|status")
      return 1
  }
}
