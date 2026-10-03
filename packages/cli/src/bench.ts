import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import {
  AiSdkProvider,
  type BenchTask,
  type BenchTaskResult,
  bashTool,
  buildSystem,
  createModelResolver,
  DEFAULT_SUITE,
  editTool,
  globTool,
  grepTool,
  loadConfig,
  readTool,
  runBenchSuite,
  ToolRegistry,
  todoTool,
} from "@butterfly/core"


export function formatBenchResultLine(result: BenchTaskResult): string {
  const m = result.metrics
  return `${result.solved ? "ok" : "FAIL"} ${result.id}  in=${m.usage.input} out=${m.usage.output} steps=${m.steps} edits=${m.editCalls} malformed=${m.malformedEdits}${result.solved ? "" : `  [check: ${result.checkOutput.slice(0, 120)}]`}`
}
export async function runBenchCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      model: { type: "string" },
      suite: { type: "string" },
      "max-steps": { type: "string" },
      "budget-per-task": { type: "string" },
      keep: { type: "boolean" },
    },
  })
  const cwd = process.cwd()
  const config = loadConfig({ cwd })
  const modelRef = values.model ?? config.model
  if (!modelRef) {
    console.error("No model configured (pass --model or set model in butterfly.jsonc).")
    return 1
  }

  let suite: BenchTask[] = DEFAULT_SUITE
  if (values.suite) {
    suite = readFileSync(resolve(values.suite), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as BenchTask)
  }

  const provider = new AiSdkProvider(createModelResolver(config))
  const makeRegistry = () => {
    const registry = new ToolRegistry()
    registry.register(bashTool)
    registry.register(readTool)
    registry.register(editTool)
    registry.register(globTool)
    registry.register(grepTool)
    registry.register(todoTool)
    return registry
  }

  console.log(`bench: ${suite.length} task(s) on ${modelRef}`)
  const summary = await runBenchSuite(suite, {
    provider,
    makeRegistry,
    model: modelRef,
    keepFixtures: values.keep === true,
    buildSystem: (fixtureCwd) =>
      buildSystem(modelRef, {
        cwd: fixtureCwd,
        platform: process.platform,
        date: new Date().toISOString().slice(0, 10),
      }),
    ...(values["max-steps"] ? { maxSteps: Number(values["max-steps"]) } : {}),
    ...(values["budget-per-task"] ? { budgetTokens: Number(values["budget-per-task"]) } : {}),
    onEvent: (message) => console.log(message),
  })

  console.log("")
  for (const result of summary.results) {
    console.log(formatBenchResultLine(result))
  }
  console.log("")
  console.log(
    `solved ${summary.solved}/${summary.total} | input tokens/solved: ${summary.inputTokensPerSolved ?? "n/a"} | malformed-edit rate: ${summary.malformedEditRate === null ? "n/a" : `${(summary.malformedEditRate * 100).toFixed(1)}%`}`,
  )
  return summary.solved === summary.total ? 0 : 1
}
