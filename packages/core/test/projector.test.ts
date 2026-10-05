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

test("foldTimeline excludes bgtask.start/bgtask.end events — bookkeeping only", () => {
  const events: SessionEvent[] = [
    { type: "message.user", id: "u1", text: "run it in the background", time: t },
    {
      type: "bgtask.start",
      id: "abc12345",
      command: "sleep 30",
      pid: 4242,
      logPath: "/tmp/abc12345.log",
      keepAlive: false,
      time: t,
    },
    { type: "message.assistant", id: "a1", text: "started task abc12345", time: t },
    { type: "bgtask.end", id: "abc12345", status: "exited", exitCode: 0, time: t },
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
  // Both per-call checkpoints must resolve to index 1 (the step's
  // message.assistant), never their own index: truncating there would leave a
  // tool.call without its tool.result.
  expect(safeRewindIndex(events, 4)).toBe(1)
  expect(safeRewindIndex(events, 6)).toBe(1)
})

test("safeRewindIndex on an out-of-range or non-snapshot index is a no-op", () => {
  const events: SessionEvent[] = [{ type: "message.user", id: "u1", text: "x", time: t }]
  expect(safeRewindIndex(events, 0)).toBe(0)
  expect(safeRewindIndex(events, 99)).toBe(99)
})

/**
 * Rewinding to a checkpoint at or before a compaction cut must restore the
 * pre-cut originals, not filter the folded list (which would leave an empty
 * timeline).
 */
test("rewinding past a compaction cut re-folds the raw prefix instead of emptying the timeline", () => {
  const events: SessionEvent[] = [
    { type: "message.user", id: "u1", text: "first ask", time: t }, // 0
    { type: "message.assistant", id: "a1", text: "first reply", time: t }, // 1
    { type: "message.user", id: "u2", text: "second ask", time: t }, // 2
    { type: "message.assistant", id: "a2", text: "second reply", time: t }, // 3
    { type: "session.compacted", summary: "earlier work", keepFromIndex: 2, time: t }, // 4
    { type: "message.user", id: "u3", text: "third ask", time: t }, // 5
    { type: "message.assistant", id: "a3", text: "third reply", time: t }, // 6
    // /undo back to before the SECOND turn — a point at/behind the cut.
    { type: "session.rewound", toIndex: 2, time: t }, // 7
  ]
  const { entries } = foldTimeline(events)
  // The correct view is fold(events[0..2)): the pre-cut originals, which the
  // rewind un-supersedes.
  expect(entries.map((e) => e.index)).toEqual([0, 1])
  expect(entries.map((e) => ("text" in e.event ? e.event.text : e.event.type))).toEqual([
    "first ask",
    "first reply",
  ])
})

test("rewinding to a point AFTER a compaction cut keeps the summary and drops only the tail", () => {
  const events: SessionEvent[] = [
    { type: "message.user", id: "u1", text: "first ask", time: t }, // 0
    { type: "message.assistant", id: "a1", text: "first reply", time: t }, // 1
    { type: "session.compacted", summary: "earlier work", keepFromIndex: 1, time: t }, // 2
    { type: "message.user", id: "u2", text: "second ask", time: t }, // 3
    { type: "message.assistant", id: "a2", text: "second reply", time: t }, // 4
    { type: "session.rewound", toIndex: 3, time: t }, // 5
  ]
  const { entries } = foldTimeline(events)
  expect(entries.map((e) => e.event.type)).toEqual(["session.compacted", "message.assistant"])
  expect(entries.map((e) => e.index)).toEqual([2, 1])
})

/**
 * Context fragments inside a rewound region must be carried forward, as the
 * compaction branch does. reconcileAgentsMd dedups against the raw journal,
 * so a dropped fragment would never be model-visible again.
 */
test("rewind carries context.fragment entries from the undone region forward", () => {
  const fragment: SessionEvent = {
    type: "context.fragment",
    source: "agents.md",
    fragments: [
      { path: "/repo/src/AGENTS.md", relPath: "src/AGENTS.md", content: "rule", truncated: false },
    ],
    time: t,
  }
  const events: SessionEvent[] = [
    { type: "message.user", id: "u1", text: "keep me", time: t }, // 0
    { type: "message.assistant", id: "a1", text: "kept reply", time: t }, // 1
    fragment, // 2 — loaded during the turn that is about to be undone
    { type: "message.user", id: "u2", text: "undone ask", time: t }, // 3
    { type: "message.assistant", id: "a2", text: "undone reply", time: t }, // 4
    { type: "session.rewound", toIndex: 2, time: t }, // 5
  ]
  const { entries } = foldTimeline(events)
  const types = entries.map((e) => e.event.type)
  expect(types).toEqual(["message.user", "message.assistant", "context.fragment"])
  const texts = entries.map((e) => ("text" in e.event ? e.event.text : e.event.type)).join("|")
  expect(texts).not.toContain("undone")
})

test("a rewind whose toIndex overshoots the journal cannot recurse forever", () => {
  const events: SessionEvent[] = [
    { type: "message.user", id: "u1", text: "hi", time: t }, // 0
    { type: "session.rewound", toIndex: 99, time: t }, // 1 — malformed/overshoot
  ]
  const { entries } = foldTimeline(events)
  expect(entries.map((e) => e.index)).toEqual([0])
})

test("two stacked rewinds fold to the earlier target", () => {
  const events: SessionEvent[] = [
    { type: "message.user", id: "u1", text: "one", time: t }, // 0
    { type: "message.assistant", id: "a1", text: "reply one", time: t }, // 1
    { type: "message.user", id: "u2", text: "two", time: t }, // 2
    { type: "session.rewound", toIndex: 2, time: t }, // 3
    { type: "message.user", id: "u3", text: "three", time: t }, // 4
    { type: "session.rewound", toIndex: 1, time: t }, // 5
  ]
  const { entries } = foldTimeline(events)
  expect(entries.map((e) => e.index)).toEqual([0])
})
