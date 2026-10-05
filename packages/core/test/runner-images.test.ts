import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { ImageRef } from "../src/context/media"
import { SessionJournal } from "../src/session/journal"
import { type RunnerDeps, runUserTurn } from "../src/session/runner"
import { ToolRegistry } from "../src/tool/registry"
import { MockProvider } from "./helpers/mock-provider"

function makeDeps(provider: MockProvider, overrides: Partial<RunnerDeps> = {}): RunnerDeps {
  const registry = new ToolRegistry()
  registry.register({
    name: "echo",
    description: "Echoes text.",
    inputSchema: z.object({ text: z.string() }),
    execute: async (input) => ({ output: `echo: ${input.text}` }),
  })
  return {
    provider,
    registry,
    journal: SessionJournal.create(mkdtempSync(join(tmpdir(), "bfly-run-img-"))),
    rules: { "*": "allow" },
    model: "mock-model",
    system: "You are Butterfly.",
    cwd: "/w",
    ...overrides,
  }
}

const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }

function oneImage(cwd: string): ImageRef {
  const bytes = Buffer.from("fake-png-bytes")
  const path = join(cwd, "shot.png")
  writeFileSync(path, bytes)
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
  return { path, mediaType: "image/png", sha256 }
}

test("a supported model journals the image path (not bytes) and receives image parts", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "bfly-run-img-cwd-"))
  const image = oneImage(cwd)
  const provider = new MockProvider([
    [
      { type: "text-delta", text: "I see it" },
      { type: "finish", reason: "stop", usage },
    ],
  ])
  const deps = makeDeps(provider, { imageInputSupported: true })

  await runUserTurn(deps, "what is this", { images: [image] })

  const { events } = SessionJournal.replay(deps.journal.path)
  const userEvent = events.find((e) => e.type === "message.user")
  if (userEvent?.type !== "message.user") throw new Error("expected message.user")
  expect(userEvent.text).toBe("what is this")
  expect(userEvent.images).toEqual([image])
  // The journal line itself must never contain the base64 bytes.
  const raw = await Bun.file(deps.journal.path).text()
  expect(raw).not.toContain(Buffer.from("fake-png-bytes").toString("base64"))

  const sent = provider.requests[0]?.messages.find((m) => m.role === "user")
  if (sent?.role !== "user" || typeof sent.content === "string") {
    throw new Error("expected part-array user content")
  }
  expect(sent.content).toEqual([
    { type: "text", text: "what is this" },
    {
      type: "image",
      mediaType: "image/png",
      data: Buffer.from("fake-png-bytes").toString("base64"),
    },
  ])
})

test("an unsupported model still JOURNALS the image (journal is model-agnostic) but sends no image bytes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "bfly-run-img-cwd-"))
  const image = oneImage(cwd)
  const provider = new MockProvider([
    [
      { type: "text-delta", text: "ok" },
      { type: "finish", reason: "stop", usage },
    ],
  ])
  const notices: string[] = []
  const deps = makeDeps(provider, {
    imageInputSupported: false,
    onEvent: (e) => {
      if (e.type === "notice") notices.push(e.text)
    },
  })

  await runUserTurn(deps, "what is this", { images: [image] })

  const { events } = SessionJournal.replay(deps.journal.path)
  const userEvent = events.find((e) => e.type === "message.user")
  if (userEvent?.type !== "message.user") throw new Error("expected message.user")
  // The journal records what the USER did, not what this model could take.
  expect(userEvent.images).toEqual([image])
  // ...and it must NOT bake a capability-dependent notice into the text.
  expect(userEvent.text).toBe("what is this")

  const sent = provider.requests[0]?.messages.find((m) => m.role === "user")
  if (sent?.role !== "user") throw new Error("expected user message")
  const hasImagePart =
    typeof sent.content !== "string" && sent.content.some((p) => p.type === "image")
  expect(hasImagePart).toBe(false)
  // The stripped attachment still names the file for the model.
  const modelText =
    typeof sent.content === "string"
      ? sent.content
      : sent.content.map((p) => (p.type === "text" ? p.text : "")).join("\n")
  expect(modelText).toContain(image.path)

  // ...and the live UI notice names it too.
  expect(notices).toHaveLength(1)
  expect(notices[0]).toContain(image.path)
  expect(notices[0]?.toLowerCase()).toContain("does not support image input")
})

test("imageInputSupported left undefined (unknown capability) also strips — only an affirmative catalog match sends images", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "bfly-run-img-cwd-"))
  const image = oneImage(cwd)
  const provider = new MockProvider([
    [
      { type: "text-delta", text: "ok" },
      { type: "finish", reason: "stop", usage },
    ],
  ])
  const deps = makeDeps(provider)

  await runUserTurn(deps, "what is this", { images: [image] })

  const { events } = SessionJournal.replay(deps.journal.path)
  const userEvent = events.find((e) => e.type === "message.user")
  if (userEvent?.type !== "message.user") throw new Error("expected message.user")
  expect(userEvent.images).toEqual([image])
  const sent = provider.requests[0]?.messages.find((m) => m.role === "user")
  if (sent?.role !== "user") throw new Error("expected user message")
  const hasImagePart =
    typeof sent.content !== "string" && sent.content.some((p) => p.type === "image")
  expect(hasImagePart).toBe(false)
})

test("switching to a text-only model mid-session strips the HISTORICAL image — no recurring provider 400", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "bfly-run-img-cwd-"))
  const image = oneImage(cwd)
  const capable = new MockProvider([
    [
      { type: "text-delta", text: "I see it" },
      { type: "finish", reason: "stop", usage },
    ],
  ])
  const deps1 = makeDeps(capable, { imageInputSupported: true })
  await runUserTurn(deps1, "what is this", { images: [image] })

  // /model switch to a text-only model: same journal, fresh deps.
  const textOnly = new MockProvider([
    [
      { type: "text-delta", text: "no vision here" },
      { type: "finish", reason: "stop", usage },
    ],
  ])
  const notices: string[] = []
  const deps2 = makeDeps(textOnly, {
    journal: deps1.journal,
    imageInputSupported: false,
    model: "text-only-model",
    onEvent: (e) => {
      if (e.type === "notice") notices.push(e.text)
    },
  })
  const outcome = await runUserTurn(deps2, "and now describe it in words")

  // (ii) the turn completes: no provider error from an unusable FilePart.
  expect(outcome.text).toBe("no vision here")
  // (i) nothing image-shaped reached the text-only provider, for ANY message.
  const anyImagePart = textOnly.requests[0]?.messages.some(
    (m) =>
      m.role === "user" &&
      typeof m.content !== "string" &&
      m.content.some((p) => p.type === "image"),
  )
  expect(anyImagePart).toBe(false)
  // (iii) the journal still carries the attachment, untouched.
  const { events } = SessionJournal.replay(deps1.journal.path)
  const first = events.find((e) => e.type === "message.user")
  if (first?.type !== "message.user") throw new Error("expected message.user")
  expect(first.images).toEqual([image])
  // History is stripped silently; the live notice is only for this turn's
  // own attachments, and it has none.
  expect(notices).toEqual([])
})

test("attaching under a text-only model then switching to a vision model SENDS the recovered image", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "bfly-run-img-cwd-"))
  const image = oneImage(cwd)
  const textOnly = new MockProvider([
    [
      { type: "text-delta", text: "cannot see" },
      { type: "finish", reason: "stop", usage },
    ],
  ])
  const deps1 = makeDeps(textOnly, { imageInputSupported: false })
  await runUserTurn(deps1, "what is this", { images: [image] })

  const capable = new MockProvider([
    [
      { type: "text-delta", text: "now I see it" },
      { type: "finish", reason: "stop", usage },
    ],
  ])
  const deps2 = makeDeps(capable, { journal: deps1.journal, imageInputSupported: true })
  await runUserTurn(deps2, "try again")

  const sent = capable.requests[0]?.messages.find(
    (m) => m.role === "user" && typeof m.content !== "string",
  )
  if (sent?.role !== "user" || typeof sent.content === "string") {
    throw new Error("expected part-array user content")
  }
  expect(sent.content).toContainEqual({
    type: "image",
    mediaType: "image/png",
    data: Buffer.from("fake-png-bytes").toString("base64"),
  })
})

test("a fresh attach under a text-only model notices ONCE, not once per step", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "bfly-run-img-cwd-"))
  const image = oneImage(cwd)
  // Two steps: a tool call, then a final text answer.
  const provider = new MockProvider([
    [
      { type: "tool-call", callId: "c1", name: "echo", input: { text: "hi" } },
      { type: "finish", reason: "tool-calls", usage },
    ],
    [
      { type: "text-delta", text: "done" },
      { type: "finish", reason: "stop", usage },
    ],
  ])
  const notices: string[] = []
  const deps = makeDeps(provider, {
    imageInputSupported: false,
    onEvent: (e) => {
      if (e.type === "notice") notices.push(e.text)
    },
  })

  await runUserTurn(deps, "what is this", { images: [image] })

  expect(provider.requests.length).toBe(2)
  expect(notices).toHaveLength(1)
})

test("an image whose bytes changed since attach is not sent — the sha256 guard fires through the runner", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "bfly-run-img-cwd-"))
  const image = oneImage(cwd)
  writeFileSync(image.path, Buffer.from("some-other-bytes-entirely"))
  const provider = new MockProvider([
    [
      { type: "text-delta", text: "ok" },
      { type: "finish", reason: "stop", usage },
    ],
  ])
  const deps = makeDeps(provider, { imageInputSupported: true })

  await runUserTurn(deps, "what is this", { images: [image] })

  const sent = provider.requests[0]?.messages.find((m) => m.role === "user")
  if (sent?.role !== "user" || typeof sent.content === "string") {
    throw new Error("expected part-array user content")
  }
  expect(sent.content.some((p) => p.type === "image")).toBe(false)
  const text = sent.content.map((p) => (p.type === "text" ? p.text : "")).join("\n")
  expect(text.toLowerCase()).toContain("changed")
})

test("no images attached behaves exactly as before — third argument is fully optional", async () => {
  const provider = new MockProvider([
    [
      { type: "text-delta", text: "hi" },
      { type: "finish", reason: "stop", usage },
    ],
  ])
  const deps = makeDeps(provider)
  const outcome = await runUserTurn(deps, "hello")
  expect(outcome.text).toBe("hi")
  const { events } = SessionJournal.replay(deps.journal.path)
  const userEvent = events.find((e) => e.type === "message.user")
  if (userEvent?.type !== "message.user") throw new Error("expected message.user")
  expect(userEvent.images).toBeUndefined()
  expect(userEvent.text).toBe("hello")
})
