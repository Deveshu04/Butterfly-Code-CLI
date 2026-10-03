import { expect, test } from "bun:test"
import {
  type AgentEntry,
  agentRows,
  agentStripLine,
  compactToolResult,
  gauge,
  planLayout,
  todoRows,
  todoStripLine,
  usageLines,
} from "../src/layout"

const base = { pref: "auto" as const, hasAgents: false, sessionStarted: true }

test("the screen divides by width: strip < 120 <= sidebar < 180 <= agents column", () => {
  expect(planLayout(100, base)).toMatchObject({ sidebar: false, agentsPane: false, strip: true })
  expect(planLayout(120, base)).toMatchObject({ sidebar: true, sidebarWidth: 32, strip: false })
  expect(planLayout(150, base).sidebarWidth).toBe(38)
  expect(planLayout(190, { ...base, hasAgents: true })).toMatchObject({
    sidebar: true,
    agentsPane: true,
    sidebarWidth: 42,
  })
  expect(planLayout(170, { ...base, hasAgents: true }).agentsPane).toBe(false)
  expect(planLayout(190, base).agentsPane).toBe(false) // no agents, no column
  // Welcome screen stays clean; the user's toggle wins.
  expect(planLayout(200, { ...base, sessionStarted: false }).sidebar).toBe(false)
  expect(planLayout(200, { ...base, pref: "off" }).sidebar).toBe(false)
  expect(planLayout(100, { ...base, pref: "on" }).sidebar).toBe(true)
})

test("hysteresis: a shown panel survives a few columns below its threshold", () => {
  const shown = planLayout(122, base)
  expect(planLayout(117, { ...base, previous: shown }).sidebar).toBe(true)
  expect(planLayout(115, { ...base, previous: shown }).sidebar).toBe(false)
  expect(planLayout(117, base).sidebar).toBe(false) // growing needs the full threshold
})

test("todo rows wrap under their text with ASCII marks", () => {
  const rows = todoRows(
    [
      { text: "Read all service files and identify bugs", status: "completed" },
      { text: "Implement fixes", status: "in_progress" },
    ],
    24,
  )
  expect(rows.map((r) => r.text)).toEqual([
    "[x] Read all service",
    "    files and identify",
    "    bugs",
    "[~] Implement fixes",
  ])
})

test("the narrow strip names progress and the current item", () => {
  expect(
    todoStripLine(
      [
        { text: "a", status: "completed" },
        { text: "fix the parser", status: "in_progress" },
      ],
      80,
    ),
  ).toBe("plan 1/2  [~] fix the parser")
  expect(todoStripLine([{ text: "a", status: "completed" }], 80)).toBe("plan 1/1  all done")
  expect(todoStripLine([], 80)).toBe("")
})

const agent = (over: Partial<AgentEntry>): AgentEntry => ({
  key: "c1:0",
  callId: "c1",
  id: "0",
  index: 0,
  total: 2,
  task: "Fix src/hooks/use-toast.ts duplicate State",
  model: "small",
  isolation: false,
  phase: "running",
  steps: 3,
  activity: 'read {"file_path":"src/hooks/use-toast.ts"}',
  updatedAt: 0,
  ...over,
})

test("agent rows show phase, steps, brief and live activity within the width", () => {
  const [head, detail] = agentRows(agent({}), 1, 30)
  expect(head).toBe("#1 run   s3 Fix src/hooks/use~")
  expect(head.length).toBe(30)
  expect(detail.length).toBeLessThanOrEqual(30)
  expect(agentRows(agent({ phase: "done" }), 2, 40)[1]).toContain("small")
  expect(agentStripLine([agent({}), agent({ key: "c1:1", phase: "done" })])).toBe(
    "agents 2 · 1 running · 1 done  (Alt+Right to view)",
  )
})

test("usage: an ASCII context gauge plus tokens, cache and spend", () => {
  expect(gauge(0.5, 17)).toBe("[#####-----]  50%")
  const lines = usageLines({
    ctxUsed: 64_000,
    ctxLimit: 128_000,
    input: 1_200_000,
    output: 40_000,
    cacheRead: 960_000,
    costUSD: "$0.42",
    width: 30,
  })
  expect(lines[1]).toBe("64.0k of 128.0k context")
  expect(lines[3]).toBe("cache 80% · spent $0.42")
})

test("compact tool results collapse reads/globs/greps to one line; unknown tools keep the block", () => {
  expect(compactToolResult("read", "[src/a.ts: 342 lines]\n1\timport x")).toBe("342 lines")
  expect(compactToolResult("read", "[a.ts: showing lines 10-60 of 400]\n10\tx")).toBe(
    "lines 10-60 of 400",
  )
  expect(compactToolResult("read", "[unchanged] a.ts: this exact range…")).toBe(
    "unchanged, already in context",
  )
  expect(
    compactToolResult("glob", "a.ts\nb.ts\n[... 3 more matches not shown — narrow the pattern]"),
  ).toBe("5 files")
  expect(compactToolResult("glob", 'No files match "x" under /w.')).toBe("no matches")
  expect(compactToolResult("grep", "a.ts:1:x\na.ts:9:y\nb.ts:2:z")).toBe("3 matches in 2 files")
  expect(compactToolResult("task", "4 subagents ran")).toBeUndefined()
})

test("a long plan is windowed around the current item", async () => {
  const { planWindow } = await import("../src/layout")
  const todos = Array.from({ length: 14 }, (_, i) => ({
    text: `step ${i + 1}`,
    status: (i < 6 ? "completed" : i === 6 ? "in_progress" : "pending") as
      | "completed"
      | "in_progress"
      | "pending",
  }))
  const w = planWindow(todos, 5)
  expect(w.doneBefore).toBe(6)
  expect(w.items.map((t) => t.text)).toEqual(["step 7", "step 8", "step 9", "step 10", "step 11"])
  expect(w.moreAfter).toBe(3)
  expect(planWindow(todos.slice(0, 4), 5).doneBefore).toBe(0)
})
