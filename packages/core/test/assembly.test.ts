import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assemble, UNANSWERED_CALL_OUTPUT } from "../src/session/assembly"
import { now, type SessionEvent } from "../src/session/events"

const t = now()

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

test("system prompt comes first, then user/assistant mapping", () => {
  const timeline: SessionEvent[] = [
    { type: "session.created", cwd: "/w", time: t },
    { type: "message.user", id: "u1", text: "hello", time: t },
    { type: "message.assistant", id: "a1", text: "hi", time: t },
  ]
  const messages = assemble({ system: "You are Butterfly.", timeline })
  expect(messages[0]).toEqual({ role: "system", content: "You are Butterfly." })
  expect(messages[1]).toEqual({ role: "user", content: "hello" })
  expect(messages[2]).toEqual({ role: "assistant", content: "hi" })
})

test("tool calls attach to their assistant step and results become tool messages", () => {
  const timeline: SessionEvent[] = [
    { type: "message.user", id: "u1", text: "read a file", time: t },
    { type: "message.assistant", id: "a1", text: "", time: t },
    { type: "tool.call", callId: "c1", name: "read", input: { file_path: "a.txt" }, time: t },
    { type: "tool.result", callId: "c1", output: "1\thello", isError: false, time: t },
    { type: "message.assistant", id: "a2", text: "done", time: t },
  ]
  const messages = assemble({ system: "s", timeline })
  expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant"])
  const assistant = messages[2]
  if (assistant?.role !== "assistant") throw new Error("expected assistant")
  expect(assistant.toolCalls).toEqual([
    { callId: "c1", name: "read", input: { file_path: "a.txt" } },
  ])
  const tool = messages[3]
  if (tool?.role !== "tool") throw new Error("expected tool")
  expect(tool.callId).toBe("c1")
  expect(tool.output).toBe("1\thello")
})

test("compaction summaries render as a labelled user message", () => {
  const timeline: SessionEvent[] = [
    { type: "session.compacted", summary: "did the old work", keepFromIndex: 3, time: t },
    { type: "message.user", id: "u2", text: "continue", time: t },
  ]
  const messages = assemble({ system: "s", timeline })
  expect(messages[1]?.role).toBe("user")
  const content = messages[1]?.role === "user" ? messages[1].content : ""
  if (typeof content !== "string") throw new Error("expected string content")
  expect(content).toContain("did the old work")
  expect(content.toLowerCase()).toContain("summary")
})

test("turn.completed and session.created events do not leak into messages", () => {
  const timeline: SessionEvent[] = [
    { type: "session.created", cwd: "/w", time: t },
    { type: "message.user", id: "u1", text: "hi", time: t },
    {
      type: "turn.completed",
      model: "m",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      time: t,
    },
  ]
  const messages = assemble({ system: "s", timeline })
  expect(messages.map((m) => m.role)).toEqual(["system", "user"])
})

test("message.user with images becomes text+image parts, bytes loaded lazily from the journaled path", () => {
  const cwd = tempDir("bfly-assembly-")
  const bytes = Buffer.from("fake-png-bytes")
  const path = join(cwd, "shot.png")
  writeFileSync(path, bytes)

  const timeline: SessionEvent[] = [
    {
      type: "message.user",
      id: "u1",
      text: "what is this",
      images: [
        {
          path,
          mediaType: "image/png",
          sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
        },
      ],
      time: t,
    },
  ]
  const messages = assemble({ system: "s", timeline, imageInputSupported: true })
  const user = messages[1]
  if (user?.role !== "user") throw new Error("expected user message")
  if (typeof user.content === "string") throw new Error("expected part array content")
  expect(user.content).toEqual([
    { type: "text", text: "what is this" },
    { type: "image", mediaType: "image/png", data: bytes.toString("base64") },
  ])
})

test("imageInputSupported false strips journaled images to path-naming text parts — no image parts", () => {
  const cwd = tempDir("bfly-assembly-")
  const path = join(cwd, "shot.png")
  writeFileSync(path, Buffer.from("fake-png-bytes"))

  const timeline: SessionEvent[] = [
    {
      type: "message.user",
      id: "u1",
      text: "what is this",
      images: [{ path, mediaType: "image/png", sha256: "deadbeef" }],
      time: t,
    },
  ]
  const messages = assemble({ system: "s", timeline, imageInputSupported: false })
  const user = messages[1]
  if (user?.role !== "user") throw new Error("expected user message")
  if (typeof user.content === "string") throw new Error("expected part array content")
  expect(user.content.some((p) => p.type === "image")).toBe(false)
  expect(user.content[0]).toEqual({ type: "text", text: "what is this" })
  const stripped = user.content[1]
  if (stripped?.type !== "text") throw new Error("expected stripped text part")
  expect(stripped.text).toContain(path)
})

test("assemble defaults to stripping images when imageInputSupported is omitted (fail-safe)", () => {
  const cwd = tempDir("bfly-assembly-")
  const path = join(cwd, "shot.png")
  writeFileSync(path, Buffer.from("fake-png-bytes"))

  const timeline: SessionEvent[] = [
    {
      type: "message.user",
      id: "u1",
      text: "what is this",
      images: [{ path, mediaType: "image/png", sha256: "deadbeef" }],
      time: t,
    },
  ]
  const messages = assemble({ system: "s", timeline })
  const user = messages[1]
  if (user?.role !== "user") throw new Error("expected user message")
  if (typeof user.content === "string") throw new Error("expected part array content")
  expect(user.content.some((p) => p.type === "image")).toBe(false)
})

test("a missing image file at replay time degrades to a placeholder text part, not a thrown error", () => {
  const cwd = tempDir("bfly-assembly-")
  const missing = join(cwd, "gone.png")

  const timeline: SessionEvent[] = [
    {
      type: "message.user",
      id: "u1",
      text: "look at this",
      images: [{ path: missing, mediaType: "image/png", sha256: "deadbeef" }],
      time: t,
    },
  ]
  const messages = assemble({ system: "s", timeline, imageInputSupported: true })
  const user = messages[1]
  if (user?.role !== "user") throw new Error("expected user message")
  if (typeof user.content === "string") throw new Error("expected part array content")
  expect(user.content[0]).toEqual({ type: "text", text: "look at this" })
  expect(user.content[1]?.type).toBe("text")
  const placeholder = user.content[1]
  if (placeholder?.type !== "text") throw new Error("expected placeholder text part")
  expect(placeholder.text).toContain(missing)
})

test("message.user without images keeps plain string content — unchanged historical shape", () => {
  const timeline: SessionEvent[] = [{ type: "message.user", id: "u1", text: "hi", time: t }]
  const messages = assemble({ system: "s", timeline })
  expect(messages[1]).toEqual({ role: "user", content: "hi" })
})



test("a dangling tool.call at the END of the timeline heals into a synthesized isError tool message", () => {
  const timeline: SessionEvent[] = [
    { type: "message.user", id: "u1", text: "do it", time: t },
    { type: "message.assistant", id: "a1", text: "", time: t },
    { type: "tool.call", callId: "c1", name: "bash", input: { command: "sleep 100" }, time: t },
  ]
  const messages = assemble({ system: "s", timeline })
  expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"])
  const tool = messages[3]
  if (tool?.role !== "tool") throw new Error("expected tool")
  expect(tool.callId).toBe("c1")
  expect(tool.name).toBe("bash")
  expect(tool.isError).toBe(true)
  expect(tool.output).toBe(UNANSWERED_CALL_OUTPUT)

  const assistant = messages[2]
  if (assistant?.role !== "assistant") throw new Error("expected assistant")
  expect(assistant.toolCalls?.map((c) => c.callId)).toEqual(["c1"])
})

test("a dangling tool.call heals BEFORE the next turn's user message, not after (provider ordering)", () => {
  const timeline: SessionEvent[] = [
    { type: "message.user", id: "u1", text: "do it", time: t },
    { type: "message.assistant", id: "a1", text: "", time: t },
    { type: "tool.call", callId: "c1", name: "bash", input: { command: "x" }, time: t },
    { type: "message.user", id: "u2", text: "continue", time: t },
    { type: "message.assistant", id: "a2", text: "done", time: t },
  ]
  const messages = assemble({ system: "s", timeline })
  expect(messages.map((m) => m.role)).toEqual([
    "system",
    "user",
    "assistant",
    "tool",
    "user",
    "assistant",
  ])
  const tool = messages[3]
  if (tool?.role !== "tool") throw new Error("expected tool")
  expect(tool.callId).toBe("c1")
  expect(tool.output).toBe(UNANSWERED_CALL_OUTPUT)
})

test("multiple dangling calls in one batch all heal, in call order; the one real result is untouched", () => {
  const timeline: SessionEvent[] = [
    { type: "message.user", id: "u1", text: "go", time: t },
    { type: "message.assistant", id: "a1", text: "", time: t },
    { type: "tool.call", callId: "c1", name: "echo", input: {}, time: t },
    { type: "tool.call", callId: "c2", name: "echo", input: {}, time: t },
    { type: "tool.call", callId: "c3", name: "echo", input: {}, time: t },
    { type: "tool.result", callId: "c1", output: "real result", isError: false, time: t },
  ]
  const messages = assemble({ system: "s", timeline })
  const toolMsgs = messages.filter((m) => m.role === "tool")
  expect(toolMsgs.map((m) => (m.role === "tool" ? m.callId : ""))).toEqual(["c1", "c2", "c3"])
  const [r1, r2, r3] = toolMsgs
  if (r1?.role !== "tool" || r2?.role !== "tool" || r3?.role !== "tool") {
    throw new Error("expected tool messages")
  }
  expect(r1.output).toBe("real result")
  expect(r1.isError).toBeUndefined()
  expect(r2.output).toBe(UNANSWERED_CALL_OUTPUT)
  expect(r2.isError).toBe(true)
  expect(r3.output).toBe(UNANSWERED_CALL_OUTPUT)
  expect(r3.isError).toBe(true)
})

test("a fully-answered timeline is completely untouched by the repair (no phantom messages)", () => {
  const timeline: SessionEvent[] = [
    { type: "message.user", id: "u1", text: "go", time: t },
    { type: "message.assistant", id: "a1", text: "", time: t },
    { type: "tool.call", callId: "c1", name: "echo", input: {}, time: t },
    { type: "tool.result", callId: "c1", output: "fine", isError: false, time: t },
    { type: "message.assistant", id: "a2", text: "done", time: t },
  ]
  const messages = assemble({ system: "s", timeline })
  expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant"])
  expect(messages.filter((m) => m.role === "tool")).toHaveLength(1)
})

test("tool.result.meta (todo/bash/edit UI hints) never rides into the assembled tool message", () => {
  const timeline: SessionEvent[] = [
    { type: "message.user", id: "u1", text: "plan it", time: t },
    { type: "message.assistant", id: "a1", text: "", time: t },
    { type: "tool.call", callId: "c1", name: "todo", input: { items: [] }, time: t },
    {
      type: "tool.result",
      callId: "c1",
      output: "(todo list cleared)",
      isError: false,
      meta: { todos: [{ text: "ship", status: "pending" }] },
      time: t,
    },
    { type: "tool.call", callId: "c2", name: "bash", input: { command: "echo hi" }, time: t },
    {
      type: "tool.result",
      callId: "c2",
      output: "hi",
      isError: false,
      meta: { command: "echo hi", exitCode: 0 },
      time: t,
    },
  ]
  const messages = assemble({ system: "s", timeline })
  const toolMessages = messages.filter((m) => m.role === "tool")
  expect(toolMessages).toHaveLength(2)
  for (const m of toolMessages) {
    expect(m).not.toHaveProperty("meta")
    expect(JSON.stringify(m)).not.toContain("meta")
  }
})
