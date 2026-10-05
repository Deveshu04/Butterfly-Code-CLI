import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { runCommand } from "@butterfly/core"
import { runLoopCommand } from "../src/loop"

/**
 * Captures what the headless attention adapter writes by making stderr look
 * like a TTY for the call. The adapter reads `process.stderr` at call time,
 * so patching the descriptor avoids needing a real PTY.
 */
async function captureStderr(fn: () => Promise<unknown>): Promise<{
  written: string
  error: unknown
}> {
  const chunks: string[] = []
  const realWrite = process.stderr.write
  const realIsTTY = process.stderr.isTTY
  Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true })
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  let error: unknown
  try {
    await fn()
  } catch (caught) {
    error = caught
  } finally {
    process.stderr.write = realWrite
    Object.defineProperty(process.stderr, "isTTY", { value: realIsTTY, configurable: true })
  }
  return { written: chunks.join(""), error }
}

/** Self-contained repo: `git status` must never escape into an ancestor repo. */
async function loopFixture(): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "bfly-loop-"))
  await runCommand("git init -q && git config user.email t@t && git config user.name t", { cwd })
  writeFileSync(
    join(cwd, "butterfly.jsonc"),
    JSON.stringify({ model: "mock/model", gates: [{ name: "noop", command: "exit 0" }] }),
  )
  await runCommand("git add -A && git commit -qm init", { cwd })
  return cwd
}

test("a loop run that blows up before runLoop still clears title + progress", async () => {
  const cwd = await loopFixture()
  // Make WorkQueue.open fail like a corrupt or locked queue would, after
  // turn.start has already set "busy + indeterminate progress".
  mkdirSync(join(cwd, ".butterfly", "queue.db"), { recursive: true })

  const { written, error } = await captureStderr(() =>
    runLoopCommand(["run", "--cwd", cwd, "--model", "mock/model"]),
  )

  expect(error).toBeDefined()
  // Started busy...
  expect(written).toContain(`\x1b]0;busy — ${basename(cwd)}\x07`)
  expect(written).toContain("\x1b]9;4;3;0\x07")
  // ...and ended idle with the progress indicator cleared.
  expect(written).toContain(`\x1b]0;idle — ${basename(cwd)}\x07`)
  expect(written).toContain("\x1b]9;4;0;0\x07")
}, 60_000)
