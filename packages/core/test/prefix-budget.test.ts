import { expect, test } from "bun:test"
import { buildSystem } from "../src/context/system"
import { estimateTokens } from "../src/context/tokens"
import { createExploreTool } from "../src/graph/explore-tool"
import { createMcpTool } from "../src/mcp/mcp-tool"
import { createMemoryTool } from "../src/memory/memory-tool"
import { createSkillTool } from "../src/memory/skill-tool"
import { ToolRegistry } from "../src/tool/registry"
import { bashTool } from "../src/tool/tools/bash"
import { editTool } from "../src/tool/tools/edit"
import { globTool } from "../src/tool/tools/glob"
import { grepTool } from "../src/tool/tools/grep"
import { readTool } from "../src/tool/tools/read"
import { createTaskTool } from "../src/tool/tools/task"
import { todoTool } from "../src/tool/tools/todo"
import { createWebTool } from "../src/web/web-tool"
import { MockProvider } from "./helpers/mock-provider"

/**
 * Keeps the system prefix (system prompt + tool schemas) small. Growth should
 * be deliberate: raise a budget here only with a reason in the commit message.
 */
function fullRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  for (const tool of [bashTool, readTool, editTool, globTool, grepTool, todoTool]) {
    registry.register(tool as never)
  }
  registry.register(
    createMemoryTool({ paths: { project: "p", user: "u" }, episodic: () => undefined }),
  )
  registry.register(createSkillTool({ dirs: [] }))
  registry.register(createWebTool({ config: () => undefined }))
  registry.register(createMcpTool({ hub: () => undefined }))
  registry.register(createExploreTool({ db: () => undefined, cwd: "." }))
  registry.register(
    createTaskTool({
      provider: () => new MockProvider([]),
      model: () => "m",
      system: () => "s",
      cwd: ".",
      sessionsDir: ".",
      makeRegistry: () => new ToolRegistry(),
    }),
  )
  return registry
}

const env = { cwd: "/repo", platform: "linux", date: "2026-10-03" }

test("the model sees exactly the 12 tools", () => {
  const names = fullRegistry()
    .list()
    .map((tool) => tool.name)
    .sort()
  expect(names).toEqual(
    [
      "bash",
      "edit",
      "explore",
      "glob",
      "grep",
      "mcp",
      "memory",
      "read",
      "skill",
      "task",
      "todo",
      "web",
    ].sort(),
  )
})

test("the tool schemas stay within their token budget", () => {
  const tokens = estimateTokens(JSON.stringify(fullRegistry().list()))
  expect(tokens).toBeLessThan(3_500)
})

test("every prompt family stays within its token budget", () => {
  for (const model of ["some/model", "anthropic/claude-x", "openai/gpt-x", "google/gemini-x"]) {
    const tokens = estimateTokens(buildSystem(model, env))
    expect({ model, tokens: tokens < 1_000 }).toEqual({ model, tokens: true })
  }
})

test("the prefix is byte-stable — two builds produce identical bytes", () => {
  expect(buildSystem("some/model", env)).toBe(buildSystem("some/model", env))
  expect(JSON.stringify(fullRegistry().list())).toBe(JSON.stringify(fullRegistry().list()))
})
