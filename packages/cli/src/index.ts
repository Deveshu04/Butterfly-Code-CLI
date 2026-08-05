#!/usr/bin/env bun
import { parseArgs } from "node:util"
import { VERSION } from "@butterfly/core"
import { runHeadless } from "./run"

const [, , command, ...rest] = process.argv

async function main(): Promise<number> {
  switch (command) {
    case "run": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          model: { type: "string" },
          budget: { type: "string" },
          "max-spend": { type: "string" },
          cwd: { type: "string" },
          json: { type: "boolean", default: false },
          "max-steps": { type: "string" },
        },
      })
      const task = positionals.join(" ").trim()
      if (task === "") {
        console.error(
          'Usage: butterfly run "<task>" [--model provider/model] [--budget tokens] [--json]',
        )
        return 1
      }
      return await runHeadless({
        task,
        model: values.model,
        budget: values.budget ? Number(values.budget) : undefined,
        maxSpendUSD: values["max-spend"] ? Number(values["max-spend"]) : undefined,
        cwd: values.cwd,
        json: values.json ?? false,
        maxSteps: values["max-steps"] ? Number(values["max-steps"]) : undefined,
      })
    }
    case "loop": {
      const { runLoopCommand } = await import("./loop")
      return await runLoopCommand(rest)
    }
    case "bench": {
      const { runBenchCommand } = await import("./bench")
      return await runBenchCommand(rest)
    }
    case "doctor": {
      const { runDoctorCommand } = await import("./doctor")
      return await runDoctorCommand(rest)
    }
    case "acp": {
      const { runAcpCommand } = await import("./acp")
      return await runAcpCommand(rest)
    }
    case "version":
    case "--version":
    case "-v":
      console.log(`butterfly code v${VERSION}`)
      return 0
    case "help":
    case "--help":
    case "-h":
      console.log(`butterfly code v${VERSION}`)
      console.log("")
      console.log("  butterfly                launch the interactive TUI")
      console.log(
        '  butterfly run "<task>"   run a task headless (exit 0 ok / 124 budget / 1 error)',
      )
      console.log('  butterfly loop plan "<spec>"  break a spec into a task queue')
      console.log("  butterfly loop run       drain the queue (gates gate, green = commit)")
      console.log("  butterfly loop status    queue counts + handoff")
      console.log("  butterfly bench          measure the harness (tokens/task, edit reliability)")
      console.log(
        "  butterfly doctor         context audit: prefix, journal, MCP savings, config lint",
      )
      console.log(
        "  butterfly acp            Agent Client Protocol server over stdio, for ACP editors",
      )
      console.log("  butterfly version        print the version")
      return 0
    default: {
      const { solidPreloadPath, tuiEntrypoint } = await import("@butterfly/tui/launch")
      const child = Bun.spawn(
        [process.execPath, "--preload", solidPreloadPath(), tuiEntrypoint()],
        {
          cwd: process.cwd(),
          env: process.env,
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        },
      )
      return await child.exited
    }
  }
}

process.exit(await main())
