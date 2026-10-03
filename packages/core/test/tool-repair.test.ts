import { expect, test } from "bun:test"
import { z } from "zod"
import { type ToolContext, ToolRegistry } from "../src/tool/registry"
import { closeTruncatedJson, repairToolInput, resolveToolName } from "../src/tool/repair"

const TOOLS = ["bash", "read", "edit", "glob", "grep", "todo", "web"]

test("tool names resolve case/separator-insensitively, then via aliases", () => {
  expect(resolveToolName("Bash", TOOLS)).toBe("bash")
  expect(resolveToolName("READ", TOOLS)).toBe("read")
  expect(resolveToolName("read_file", TOOLS)).toBe("read")
  expect(resolveToolName("str_replace_editor", TOOLS)).toBe("edit")
  expect(resolveToolName("run-command", TOOLS)).toBe("bash")
  expect(resolveToolName("TodoWrite", TOOLS)).toBe("todo")
  expect(resolveToolName("teleport", TOOLS)).toBeUndefined()
  // An alias to a tool this registry doesn't have is no resolution.
  expect(resolveToolName("web_search", ["read"])).toBeUndefined()
})

test("truncated JSON objects are closed; complete or non-object text is not", () => {
  expect(closeTruncatedJson('{"file_path": "a.ts"')).toBe('{"file_path": "a.ts"}')
  expect(closeTruncatedJson('{"command": "ls -la')).toBe('{"command": "ls -la"}')
  expect(closeTruncatedJson('{"items": [{"text": "a", "status": "pending"},')).toBe(
    '{"items": [{"text": "a", "status": "pending"}]}',
  )
  expect(closeTruncatedJson('{"a": 1, "b":')).toBe('{"a": 1}')
  expect(closeTruncatedJson('{"a": 1}')).toBeUndefined()
  expect(closeTruncatedJson("ls -la")).toBeUndefined()
  expect(closeTruncatedJson('{"a": 1]}')).toBeUndefined()
})

test("string inputs become objects when they are (possibly truncated) JSON", () => {
  expect(repairToolInput({ a: 1 })).toEqual({ input: { a: 1 } })
  const encoded = repairToolInput('{"file_path":"a.ts"}')
  expect(encoded.input).toEqual({ file_path: "a.ts" })
  expect(encoded.note).toContain("JSON string")
  const truncated = repairToolInput('{"file_path": "a.ts"')
  expect(truncated.input).toEqual({ file_path: "a.ts" })
  expect(truncated.note).toContain("truncated")
  expect(repairToolInput("not json")).toEqual({ input: "not json" })
  expect(repairToolInput('"just a string"')).toEqual({ input: '"just a string"' })
})

function registry() {
  const r = new ToolRegistry()
  r.register({
    name: "read",
    description: "r",
    inputSchema: z.object({ file_path: z.string() }),
    execute: async (input) => ({ output: `read ${input.file_path}` }),
  })
  return r
}
const ctx: ToolContext = { cwd: process.cwd(), rules: { "*": "allow" }, state: {} }

test("the registry runs repaired calls and tells the model what it assumed", async () => {
  const renamed = await registry().run("Read_File", { file_path: "a.ts" }, ctx)
  expect(renamed.isError).toBe(false)
  expect(renamed.output).toBe(
    'read a.ts\n[harness note: called as "Read_File" — the tool is named "read"]',
  )
  const encoded = await registry().run("read", '{"file_path":"b.ts"}', ctx)
  expect(encoded.isError).toBe(false)
  expect(encoded.output).toStartWith("read b.ts\n[harness note: arguments arrived as a JSON string")
})

test("unrepairable calls still fail with the actionable error", async () => {
  const unknown = await registry().run("teleport", {}, ctx)
  expect(unknown.isError).toBe(true)
  expect(unknown.output).toContain('Unknown tool "teleport". Available tools: read')
  const bad = await registry().run("read", "nonsense", ctx)
  expect(bad.isError).toBe(true)
  expect(bad.output).toContain("Invalid input for read")
  // A repaired name with still-invalid input keeps the note on the error.
  const both = await registry().run("READ", { wrong: 1 }, ctx)
  expect(both.isError).toBe(true)
  expect(both.output).toContain("Invalid input for read")
  expect(both.output).toContain('the tool is named "read"')
})
