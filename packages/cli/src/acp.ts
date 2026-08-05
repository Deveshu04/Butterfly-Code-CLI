import { homedir } from "node:os"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { AiSdkProvider, createModelResolver, loadConfig, VERSION } from "@butterfly/core"
import { connectAcpAgent } from "./acp/agent"

export async function runAcpCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      model: { type: "string" },
      cwd: { type: "string" },
      home: { type: "string" },
    },
  })
  const cwd = resolve(values.cwd ?? process.cwd())
  const home = values.home ?? homedir()
  const config = loadConfig({ cwd, home })
  const provider = new AiSdkProvider(createModelResolver(config))
  const modelRef = values.model ?? config.model

  const peer = connectAcpAgent(
    (line) => {
      process.stdout.write(line)
    },
    {
      provider,
      ...(modelRef ? { model: modelRef } : {}),
      home,
      agentInfo: { name: "butterfly", title: "Butterfly Code", version: VERSION },
    },
  )

  process.stderr.write(`butterfly acp v${VERSION} — listening on stdio (ndjson JSON-RPC)\n`)

  let buffer = ""
  for await (const chunk of process.stdin) {
    buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
    let newlineIndex = buffer.indexOf("\n")
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex)
      buffer = buffer.slice(newlineIndex + 1)
      peer.handleLine(line).catch((error) => {
        process.stderr.write(
          `acp: unhandled error: ${error instanceof Error ? error.message : String(error)}\n`,
        )
      })
      newlineIndex = buffer.indexOf("\n")
    }
  }
  return 0
}
