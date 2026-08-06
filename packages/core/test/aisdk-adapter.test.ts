import { expect, test } from "bun:test"
import { APICallError } from "ai"
import { buildErrorEvent, toModelMessages } from "../src/provider/aisdk-adapter"
import type { ChatMessage } from "../src/provider/port"


test("plain string user content maps through unchanged", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "hello" }]
  const { model } = toModelMessages(messages)
  expect(model).toEqual([{ role: "user", content: "hello" }])
})

test("text+image parts map to AI SDK v7's TextPart + FilePart shape", () => {
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "what is this" },
        { type: "image", mediaType: "image/png", data: "QUJD" },
      ],
    },
  ]
  const { model } = toModelMessages(messages)
  expect(model).toEqual([
    {
      role: "user",
      content: [
        { type: "text", text: "what is this" },
        { type: "file", mediaType: "image/png", data: "QUJD" },
      ],
    },
  ])
})

test("an image-only part list (no text) maps to a single-element FilePart array", () => {
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: [{ type: "image", mediaType: "image/jpeg", data: "Zm9v" }],
    },
  ]
  const { model } = toModelMessages(messages)
  expect(model).toEqual([
    { role: "user", content: [{ type: "file", mediaType: "image/jpeg", data: "Zm9v" }] },
  ])
})


test("buildErrorEvent stamps providerId onto info.provider when classification found none", () => {
  const error = new APICallError({
    message: "Incorrect API key provided",
    url: "https://api.openai.com/v1/chat/completions",
    requestBodyValues: {},
    statusCode: 401,
  })
  const event = buildErrorEvent(error, "openrouter")
  expect(event.type).toBe("error")
  expect(event.info?.kind).toBe("auth")
  expect(event.info?.provider).toBe("openrouter")
  expect(event.message).toBe("invalid or missing API key (401) — /provider to update it")
})

test("buildErrorEvent never renders [object Object] for a raw plain-object stream error part", () => {
  const rawStreamErrorPart = { foo: "unrecognized shape", nested: { bar: 1 } }
  const event = buildErrorEvent(rawStreamErrorPart, "ollama")
  expect(event.message).not.toContain("[object Object]")
  expect(event.message).toContain("unknown provider error:")
  expect(event.info?.kind).toBe("unknown")
  expect(event.info?.provider).toBe("ollama")
})

test("buildErrorEvent keeps a classification-provided provider over the stamped providerId", () => {
  const event = buildErrorEvent("plain string error", "openrouter")
  expect(event.info?.provider).toBe("openrouter")
})
