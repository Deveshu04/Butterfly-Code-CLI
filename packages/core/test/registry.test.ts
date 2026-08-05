import { expect, test } from "bun:test"
import { z } from "zod"
import { type ToolContext, ToolRegistry } from "../src/tool/registry"

function makeRegistry() {
  const registry = new ToolRegistry()
  registry.register({
    name: "echo",
    description: "Echoes back the given text.",
    inputSchema: z.object({ text: z.string() }),
    permissionTarget: (input) => input.text,
    execute: async (input) => ({ output: `echo: ${input.text}` }),
  })
  return registry
}

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: process.cwd(), rules: { "*": "allow" }, state: {}, ...overrides }
}

test("list exposes name, description and a JSON-schema input", () => {
  const specs = makeRegistry().list()
  expect(specs.length).toBe(1)
  const spec = specs[0]
  expect(spec?.name).toBe("echo")
  expect(spec?.description).toContain("Echoes")
  expect(spec?.inputSchema.type).toBe("object")
})

test("run executes a valid call and returns output", async () => {
  const result = await makeRegistry().run("echo", { text: "hi" }, ctx())
  expect(result).toEqual({ output: "echo: hi", isError: false, truncated: false })
})

test("invalid input returns an actionable validation error without executing", async () => {
  const result = await makeRegistry().run("echo", { wrong: 1 }, ctx())
  expect(result.isError).toBe(true)
  expect(result.output).toContain("text")
})

test("unknown tool names the available tools", async () => {
  const result = await makeRegistry().run("nope", {}, ctx())
  expect(result.isError).toBe(true)
  expect(result.output).toContain("echo")
})

test("deny rules block execution", async () => {
  const result = await makeRegistry().run(
    "echo",
    { text: "secret" },
    ctx({ rules: { echo: "deny" } }),
  )
  expect(result.isError).toBe(true)
  expect(result.output).toContain("denied")
})

test("ask consults the callback and honors allow", async () => {
  const asked: string[] = []
  const result = await makeRegistry().run(
    "echo",
    { text: "hi" },
    ctx({
      rules: { echo: "ask" },
      ask: async (request) => {
        asked.push(`${request.tool}:${request.target}`)
        return "allow"
      },
    }),
  )
  expect(asked).toEqual(["echo:hi"])
  expect(result.isError).toBe(false)
})

test("permissionNote rides the ask request so the prompt can disclose transit", async () => {
  const registry = new ToolRegistry()
  registry.register({
    name: "fetchy",
    description: "Fetches.",
    inputSchema: z.object({ url: z.string() }),
    permissionTarget: (input) => new URL(input.url).host,
    permissionNote: () => "via r.jina.ai",
    execute: async () => ({ output: "ok" }),
  })
  let seen: { target?: string; note?: string } | undefined
  const result = await registry.run(
    "fetchy",
    { url: "https://example.com/x" },
    ctx({
      rules: { fetchy: "ask" },
      ask: async (request) => {
        seen = { target: request.target, note: request.note }
        return "allow"
      },
    }),
  )
  // The note is a UI-only disclosure: the permission TARGET stays exactly the
  // host so wildcard rules keep matching.
  expect(seen).toEqual({ target: "example.com", note: "via r.jina.ai" })
  expect(result.isError).toBe(false)
})

test("ask without a callback resolves to a denial explaining approval", async () => {
  const result = await makeRegistry().run("echo", { text: "hi" }, ctx({ rules: { echo: "ask" } }))
  expect(result.isError).toBe(true)
  expect(result.output).toContain("approval")
})

test("tool meta rides through untouched by settle (UI-only channel)", async () => {
  const registry = new ToolRegistry()
  registry.register({
    name: "differ",
    description: "Returns UI metadata.",
    inputSchema: z.object({}),
    execute: async () => ({ output: "ok", meta: { diff: "--- a\n+++ b" } }),
  })
  const result = await registry.run("differ", {}, ctx())
  expect(result.meta).toEqual({ diff: "--- a\n+++ b" })
  expect(result.output).toBe("ok")
})

test("oversized output is settled with truncation", async () => {
  const registry = new ToolRegistry()
  registry.register({
    name: "flood",
    description: "Returns a lot of text.",
    inputSchema: z.object({}),
    execute: async () => ({ output: "y".repeat(200_000) }),
  })
  const result = await registry.run("flood", {}, ctx({ settle: { maxChars: 5_000 } }))
  expect(result.truncated).toBe(true)
  expect(result.output.length).toBeLessThanOrEqual(5_000)
})

test("beforeExecute runs after the permission gate resolves, before execute", async () => {
  const calls: string[] = []
  const registry = new ToolRegistry()
  registry.register({
    name: "echo",
    description: "e",
    inputSchema: z.object({ text: z.string() }),
    execute: async (input) => {
      calls.push("execute")
      return { output: input.text }
    },
  })
  const result = await registry.run(
    "echo",
    { text: "hi" },
    ctx({
      beforeExecute: async () => {
        calls.push("before")
      },
    }),
  )
  expect(calls).toEqual(["before", "execute"])
  expect(result.isError).toBe(false)
})

test("beforeExecute does not run when the tool is denied", async () => {
  const calls: string[] = []
  const result = await makeRegistry().run(
    "echo",
    { text: "x" },
    ctx({
      rules: { echo: "deny" },
      beforeExecute: async () => {
        calls.push("before")
      },
    }),
  )
  expect(calls).toEqual([])
  expect(result.isError).toBe(true)
})

test("beforeExecute does not run when an ask decision is denied", async () => {
  const calls: string[] = []
  const result = await makeRegistry().run(
    "echo",
    { text: "x" },
    ctx({
      rules: { echo: "ask" },
      ask: async () => "deny",
      beforeExecute: async () => {
        calls.push("before")
      },
    }),
  )
  expect(calls).toEqual([])
  expect(result.isError).toBe(true)
})

test("a throwing tool is captured as an error result, not an exception", async () => {
  const registry = new ToolRegistry()
  registry.register({
    name: "boom",
    description: "Always throws.",
    inputSchema: z.object({}),
    execute: async () => {
      throw new Error("kaboom")
    },
  })
  const result = await registry.run("boom", {}, ctx())
  expect(result.isError).toBe(true)
  expect(result.output).toContain("kaboom")
})
