import { expect, test } from "bun:test"
import { now, type SessionEvent } from "../src/session/events"
import { foldTimeline, safeRewindIndex } from "../src/session/projector"

const t = now()

test("foldTimeline excludes hook.run events — bookkeeping only, like turn.snapshot", () => {
  const events: SessionEvent[] = [
    { type: "message.user", id: "u1", text: "hi", time: t },
    {
      type: "hook.run",
      event: "turn.start",
      command: "true",
      exitCode: 0,
      durationMs: 5,
      blocked: false,
      feedback: false,
      outputHead: "",
      time: t,
    },
    { type: "message.assistant", id: "a1", text: "ok", time: t },
  ]
  const { entries } = foldTimeline(events)
  expect(entries.map((e) => e.event.type)).toEqual(["message.user", "message.assistant"])
})

test("safeRewindIndex passes through a turn-start checkpoint (no callId) unchanged", () => {
  const events: SessionEvent[] = [
    { type: "turn.snapshot", tree: "a".repeat(40), untracked: [], time: t },
    { type: "message.user", id: "u1", text: "do it", time: t },
    { type: "message.assistant", id: "a1", text: "ok", time: t },
  ]
  expect(safeRewindIndex(events, 0)).toBe(0)
})

test("safeRewindIndex walks a per-call checkpoint back to its step's message.assistant", () => {
  const events: SessionEvent[] = [
    { type: "message.user", id: "u1", text: "edit two files", time: t },
    { type: "message.assistant", id: "a1", text: "", time: t }, // index 1 — step start
    { type: "tool.call", callId: "c1", name: "edit", input: {}, time: t }, // 2
    { type: "tool.call", callId: "c2", name: "bash", input: {}, time: t }, // 3
    {
      type: "turn.snapshot",
      tree: "b".repeat(40),
      callId: "c1",
      tool: "edit",
      untracked: [],
      time: t,
    }, // 4 — checkpoint before c1 runs
    { type: "tool.result", callId: "c1", output: "ok", isError: false, time: t }, // 5
    {
      type: "turn.snapshot",
      tree: "c".repeat(40),
      callId: "c2",
      tool: "bash",
      untracked: [],
      time: t,
    }, // 6 — checkpoint before c2 runs
    { type: "tool.result", callId: "c2", output: "ok", isError: false, time: t }, // 7
  ]
  expect(safeRewindIndex(events, 4)).toBe(1)
  expect(safeRewindIndex(events, 6)).toBe(1)
})

test("safeRewindIndex on an out-of-range or non-snapshot index is a no-op", () => {
  const events: SessionEvent[] = [{ type: "message.user", id: "u1", text: "x", time: t }]
  expect(safeRewindIndex(events, 0)).toBe(0)
  expect(safeRewindIndex(events, 99)).toBe(99)
})
