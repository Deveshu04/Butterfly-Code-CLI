import { expect, test } from "bun:test"
import type { RunnerEvent } from "@butterfly/core"
import { renderEvent } from "../src/run"

/**
 * `butterfly run`'s non-JSON rendering is plain ASCII: "->" for a tool call,
 * "ok"/"failed" for a result, never glyphs.
 */

function captureStdout(run: () => void): string {
  const original = process.stdout.write.bind(process.stdout)
  let out = ""
  ;(process.stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    out += chunk
    return true
  }
  try {
    run()
  } finally {
    process.stdout.write = original
  }
  return out
}

test("a tool-call event prints a plain ASCII arrow, never the unicode glyph", () => {
  const event: RunnerEvent = {
    type: "tool-call",
    callId: "c1",
    name: "read",
    input: { file_path: "app.ts" },
  }
  const out = captureStdout(() => renderEvent(event, false))
  expect(out).toContain("-> read ")
  expect(out).not.toContain("→")
})

test("a tool-result event prints plain 'ok'/'failed' words, never a check/cross glyph", () => {
  const ok: RunnerEvent = {
    type: "tool-result",
    callId: "c1",
    name: "read",
    output: "export const v = 1",
    isError: false,
  }
  const failed: RunnerEvent = {
    type: "tool-result",
    callId: "c1",
    name: "read",
    output: "not found",
    isError: true,
  }
  const okOut = captureStdout(() => renderEvent(ok, false))
  const failedOut = captureStdout(() => renderEvent(failed, false))
  expect(okOut).toContain("ok export const v = 1")
  expect(failedOut).toContain("failed not found")
  for (const out of [okOut, failedOut]) {
    expect(out).not.toContain("✓")
    expect(out).not.toContain("✗")
  }
})

test("json mode is untouched by the ASCII sweep — it's structured output, not display text", () => {
  const event: RunnerEvent = {
    type: "tool-call",
    callId: "c1",
    name: "read",
    input: { file_path: "app.ts" },
  }
  // JSON mode uses console.log, not process.stdout.write, so it needs its own mock.
  const original = console.log
  let out = ""
  console.log = (chunk: string) => {
    out += chunk
  }
  try {
    renderEvent(event, true)
  } finally {
    console.log = original
  }
  expect(JSON.parse(out)).toMatchObject({ event: "tool-call", name: "read" })
})
