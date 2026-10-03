import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionJournal } from "../src/session/journal"
import { runUserTurn } from "../src/session/runner"
import { type ToolContext, ToolRegistry } from "../src/tool/registry"
import { readTool } from "../src/tool/tools/read"
import { MockProvider, zeroUsage } from "./helpers/mock-provider"

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "bfly-readdedup-"))
  writeFileSync(join(dir, "a.ts"), "export const a = 1\nexport const b = 2\n")
  return dir
}

function ctx(
  cwd: string,
  state: Record<string, unknown>,
  callId: string,
  visible: string[],
): ToolContext {
  return {
    cwd,
    rules: { "*": "allow" },
    state,
    callId,
    isResultVisible: (id) => visible.includes(id),
  }
}

test("an identical re-read of unchanged bytes points back to the visible earlier result", async () => {
  const dir = fixture()
  const state: Record<string, unknown> = {}
  const first = await readTool.execute({ file_path: "a.ts" }, ctx(dir, state, "c1", []))
  expect(first.output).toContain("export const a = 1")
  const second = await readTool.execute({ file_path: "a.ts" }, ctx(dir, state, "c2", ["c1"]))
  expect(second.output).toStartWith("[unchanged] a.ts")
  expect(second.isError).toBeUndefined()
})

test("changed bytes, a different window, or an invisible earlier result all read in full", async () => {
  const dir = fixture()
  const state: Record<string, unknown> = {}
  await readTool.execute({ file_path: "a.ts" }, ctx(dir, state, "c1", []))
  // Earlier result pruned/compacted/rewound away → not visible → full text.
  const invisible = await readTool.execute({ file_path: "a.ts" }, ctx(dir, state, "c2", []))
  expect(invisible.output).toContain("export const a = 1")
  // Different window.
  const window = await readTool.execute(
    { file_path: "a.ts", offset: 2 },
    ctx(dir, state, "c3", ["c1", "c2"]),
  )
  expect(window.output).toContain("export const b = 2")
  // Changed bytes.
  writeFileSync(join(dir, "a.ts"), "export const a = 42\nexport const b = 2\n")
  const changed = await readTool.execute({ file_path: "a.ts" }, ctx(dir, state, "c4", ["c1", "c2"]))
  expect(changed.output).toContain("export const a = 42")
})

test("without the runner's visibility hook nothing is ever deduplicated", async () => {
  const dir = fixture()
  const state: Record<string, unknown> = {}
  const base: ToolContext = { cwd: dir, rules: { "*": "allow" }, state }
  await readTool.execute({ file_path: "a.ts" }, { ...base, callId: "c1" })
  const again = await readTool.execute({ file_path: "a.ts" }, { ...base, callId: "c2" })
  expect(again.output).toContain("export const a = 1")
})

test("end to end: the runner dedups a re-read on a later step, and the model sees the stub", async () => {
  const dir = fixture()
  const registry = new ToolRegistry()
  registry.register(readTool)
  const read = (id: string) => [
    { type: "tool-call" as const, callId: id, name: "read", input: { file_path: "a.ts" } },
    { type: "finish" as const, reason: "tool-calls" as const, usage: zeroUsage },
  ]
  const provider = new MockProvider([
    read("r1"),
    read("r2"),
    [
      { type: "text-delta" as const, text: "done" },
      { type: "finish" as const, reason: "stop" as const, usage: zeroUsage },
    ],
  ])
  const journal = SessionJournal.create(mkdtempSync(join(tmpdir(), "bfly-readdedup-j-")))
  await runUserTurn(
    {
      provider,
      registry,
      journal,
      rules: { "*": "allow" },
      model: "m",
      system: "s",
      cwd: dir,
      state: {},
    },
    "look twice",
  )
  const results = SessionJournal.replay(journal.path).events.filter((e) => e.type === "tool.result")
  expect(results.map((e) => (e.type === "tool.result" ? e.output.slice(0, 11) : ""))).toEqual([
    "[a.ts: 2 li",
    "[unchanged]",
  ])
})
