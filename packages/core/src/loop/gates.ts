import { settle } from "../tool/settle"
import { runCommand } from "../tool/shell"


export interface Gate {
  name: string
  command: string
}

export interface GateRunResult {
  passed: boolean
  results: { name: string; exitCode: number; output: string }[]
}

const GATE_OUTPUT_CAP = 8_000
const GATE_TIMEOUT_MS = 600_000

export async function runGates(gates: Gate[], cwd: string): Promise<GateRunResult> {
  const results: GateRunResult["results"] = []
  for (const gate of gates) {
    const run = await runCommand(gate.command, { cwd, timeoutMs: GATE_TIMEOUT_MS })
    const combined = [run.stdout, run.stderr].filter((part) => part.trim() !== "").join("\n")
    results.push({
      name: gate.name,
      exitCode: run.timedOut ? 124 : run.exitCode,
      output: settle(combined, { maxChars: GATE_OUTPUT_CAP }).text,
    })
    if (run.exitCode !== 0 || run.timedOut) {
      return { passed: false, results }
    }
  }
  return { passed: true, results }
}
