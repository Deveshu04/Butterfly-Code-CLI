import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { compactSession } from "../src/session/compaction"
import { now, type SessionEvent } from "../src/session/events"
import { SessionJournal } from "../src/session/journal"
import { project } from "../src/session/projector"
import { planPrune } from "../src/session/prune"
import { runUserTurn } from "../src/session/runner"
import { todosFromTimeline } from "../src/session/todo-state"
import { ToolRegistry } from "../src/tool/registry"
import { TODO_STATE_KEY, todoTool } from "../src/tool/tools/todo"
import { MockProvider, zeroUsage } from "./helpers/mock-provider"

const t = now()
const items = (...statuses: ("pending" | "in_progress" | "completed")[]) =>
  statuses.map((status, i) => ({ text: `step ${i + 1}`, status }))

const todoCall = (id: string, list: ReturnType<typeof items>, isError = false): SessionEvent[] => [
  { type: "tool.call", callId: id, name: "todo", input: { items: list }, time: t },
  { type: "tool.result", callId: id, output: "x", isError, time: t },
]

test("the latest successful todo call defines the list; failed calls do not", () => {
  const timeline: SessionEvent[] = [
    ...todoCall("a", items("pending")),
    ...todoCall("b", items("completed", "pending")),
    ...todoCall("c", items("completed", "completed"), true),
  ]
  expect(todosFromTimeline(timeline)).toEqual(items("completed", "pending"))
  expect(todosFromTimeline([])).toBeUndefined()
})

test("a compaction event carries the list across the cut", () => {
  const timeline: SessionEvent[] = [
    {
      type: "session.compacted",
      summary: "s",
      keepFromIndex: 3,
      todos: items("in_progress"),
      time: t,
    },
  ]
  expect(todosFromTimeline(timeline)).toEqual(items("in_progress"))
  // Old journals (no todos field) fold to "no list".
  expect(
    todosFromTimeline([{ type: "session.compacted", summary: "s", keepFromIndex: 0, time: t }]),
  ).toBeUndefined()
})

test("pruning never evicts the result that defines the current plan", () => {
  const big = "y".repeat(10_000)
  const events: SessionEvent[] = [
    {
      type: "tool.call",
      callId: "plan",
      name: "todo",
      input: { items: items("pending") },
      time: t,
    },
    { type: "tool.result", callId: "plan", output: big, isError: false, time: t },
    { type: "tool.call", callId: "old", name: "bash", input: {}, time: t },
    { type: "tool.result", callId: "old", output: big, isError: false, time: t },
    { type: "tool.call", callId: "new", name: "bash", input: {}, time: t },
    { type: "tool.result", callId: "new", output: big, isError: false, time: t },
  ]
  expect(planPrune(events, { windowTokens: 100 })).toEqual(["old"])
})

function deps(journal: SessionJournal, state: Record<string, unknown>, provider: MockProvider) {
  const registry = new ToolRegistry()
  registry.register(todoTool)
  return {
    provider,
    registry,
    journal,
    rules: { "*": "allow" as const },
    model: "m",
    system: "sys",
    cwd: "/w",
    state,
  }
}
const say = (text: string) => [
  { type: "text-delta" as const, text },
  { type: "finish" as const, reason: "stop" as const, usage: zeroUsage },
]

test("a resumed session gets its plan back from the journal", async () => {
  const journal = SessionJournal.create(mkdtempSync(join(tmpdir(), "bfly-todo-")))
  journal.append({ type: "message.user", id: "u1", text: "go", time: t })
  journal.append({ type: "message.assistant", id: "a1", text: "", time: t })
  for (const event of todoCall("p", items("completed", "in_progress"))) journal.append(event)
  const state: Record<string, unknown> = {} // fresh process: nothing in memory
  await runUserTurn(
    deps(SessionJournal.open(journal.path), state, new MockProvider([say("ok")])),
    "continue",
  )
  expect(state[TODO_STATE_KEY]).toEqual(items("completed", "in_progress"))
})

test("a new timeline never inherits the previous one's plan from the state bag", async () => {
  const journal = SessionJournal.create(mkdtempSync(join(tmpdir(), "bfly-todo-")))
  const state: Record<string, unknown> = { [TODO_STATE_KEY]: items("pending", "pending") }
  await runUserTurn(deps(journal, state, new MockProvider([say("hi")])), "hello")
  expect(state[TODO_STATE_KEY]).toBeUndefined()
})

test("compaction stores the plan + edited files and appends them to the summary", async () => {
  const journal = SessionJournal.create(mkdtempSync(join(tmpdir(), "bfly-todo-")))
  const filler = "z".repeat(4_000)
  journal.append({ type: "message.user", id: "u1", text: `first ${filler}`, time: t })
  journal.append({ type: "message.assistant", id: "a1", text: "", time: t })
  journal.append({
    type: "tool.call",
    callId: "e1",
    name: "edit",
    input: { file_path: "src/a.ts" },
    time: t,
  })
  journal.append({ type: "tool.result", callId: "e1", output: "Edited", isError: false, time: t })
  journal.append({
    type: "tool.call",
    callId: "e2",
    name: "edit",
    input: { file_path: "src/bad.ts" },
    time: t,
  })
  journal.append({
    type: "tool.result",
    callId: "e2",
    output: "Edit rejected",
    isError: true,
    time: t,
  })
  for (const event of todoCall("p", items("completed", "pending"))) journal.append(event)
  journal.append({ type: "message.user", id: "u2", text: "second", time: t })
  journal.append({ type: "message.assistant", id: "a2", text: "short reply", time: t })

  const provider = new MockProvider([say("## Objective\n- the work")])
  const result = await compactSession({ provider, model: "m", journal, keepTokens: 200 })
  expect(result).not.toBeNull()
  const { events } = SessionJournal.replay(journal.path)
  const compacted = events.find((e) => e.type === "session.compacted")
  if (compacted?.type !== "session.compacted") throw new Error("no compaction")
  expect(compacted.todos).toEqual(items("completed", "pending"))
  expect(compacted.files).toEqual(["src/a.ts"])
  expect(compacted.summary).toContain(
    "## Todo list (harness record — current)\n[x] step 1\n[ ] step 2",
  )
  expect(compacted.summary).toContain("## Files edited so far (harness record)\nsrc/a.ts")

  // After the cut the plan is still derivable from the folded timeline.
  const header = SessionJournal.replay(journal.path).header
  expect(todosFromTimeline(project(header, events).timeline)).toEqual(items("completed", "pending"))
})

test("the compaction record carries a code-graph map of the edited files when one is supplied", async () => {
  const journal = SessionJournal.create(mkdtempSync(join(tmpdir(), "bfly-todo-")))
  journal.append({ type: "message.user", id: "u1", text: `first ${"z".repeat(4_000)}`, time: t })
  journal.append({ type: "message.assistant", id: "a1", text: "", time: t })
  journal.append({
    type: "tool.call",
    callId: "e1",
    name: "edit",
    input: { file_path: "src/cart.ts" },
    time: t,
  })
  journal.append({ type: "tool.result", callId: "e1", output: "Edited", isError: false, time: t })
  journal.append({ type: "message.user", id: "u2", text: "second", time: t })
  journal.append({ type: "message.assistant", id: "a2", text: "ok", time: t })
  const seen: string[][] = []
  await compactSession({
    provider: new MockProvider([say("## Objective\n- cart")]),
    model: "m",
    journal,
    keepTokens: 40, // cut everything up to the last reply
    codeMap: (files) => {
      seen.push(files)
      return "src/cart.ts — total:12, addItem:30"
    },
  })
  expect(seen).toEqual([["src/cart.ts"]])
  const compacted = SessionJournal.replay(journal.path).events.find(
    (e) => e.type === "session.compacted",
  )
  expect(compacted?.type === "session.compacted" && compacted.summary).toContain(
    "## Code map of edited files (harness record)\nsrc/cart.ts — total:12, addItem:30",
  )
})
