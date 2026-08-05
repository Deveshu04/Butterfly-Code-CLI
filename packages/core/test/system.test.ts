import { expect, test } from "bun:test"
import { buildSystem, selectPromptFamily } from "../src/context/system"

test("selects the family by model-id substring", () => {
  expect(selectPromptFamily("anthropic/claude-sonnet-5")).toBe("anthropic")
  expect(selectPromptFamily("openai/gpt-5-mini")).toBe("gpt")
  expect(selectPromptFamily("google/gemini-2.5-flash")).toBe("gemini")
  expect(selectPromptFamily("deepseek/deepseek-chat-v3")).toBe("default")
  expect(selectPromptFamily("openai/codex-mini")).toBe("gpt")
})

test("system prefix contains identity, environment, and tool rules", () => {
  const system = buildSystem("deepseek/deepseek-chat-v3", {
    cwd: "D:\\repo",
    platform: "win32",
    date: "2026-08-03",
  })
  expect(system).toContain("Butterfly")
  expect(system).toContain("D:\\repo")
  expect(system).toContain("win32")
  expect(system).toContain("2026-08-03")
  expect(system.toLowerCase()).toContain("node_modules")
})

test("system prefix is deterministic for identical inputs", () => {
  const env = { cwd: "/w", platform: "linux", date: "2026-08-03" }
  expect(buildSystem("m", env)).toBe(buildSystem("m", env))
})

test("project memory is embedded when provided", () => {
  const system = buildSystem("m", {
    cwd: "/w",
    platform: "linux",
    date: "2026-08-03",
    projectMemory: "Build with `bun test` only.",
  })
  expect(system).toContain("bun test")
})
