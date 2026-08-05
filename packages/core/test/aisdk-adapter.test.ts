import { expect, test } from "bun:test"
import { toModelMessages } from "../src/provider/aisdk-adapter"
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
