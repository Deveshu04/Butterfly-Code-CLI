import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  loadConfig,
  loadRawConfig,
  locateHooksSource,
  saveGlobalConfig,
  setHookEnabled,
  setPermissionRule,
} from "../src/config/config"

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bfly-config-"))
}

test("loads and merges global then project config with env substitution", () => {
  const home = tempDir()
  const cwd = tempDir()
  mkdirSync(join(home, ".config", "butterfly"), { recursive: true })
  writeFileSync(
    join(home, ".config", "butterfly", "butterfly.jsonc"),
    `{
  // global defaults
  "model": "openrouter/global-model",
  "providers": { "openrouter": { "apiKey": "{env:OR_KEY}" } },
}`,
  )
  writeFileSync(join(cwd, "butterfly.jsonc"), `{ "model": "ollama/qwen3:4b" }`)

  const config = loadConfig({ cwd, home, env: { OR_KEY: "sk-from-env" } })
  expect(config.model).toBe("ollama/qwen3:4b")
  expect(config.providers?.["openrouter"]?.apiKey).toBe("sk-from-env")
})

test("returns an empty config when no files exist", () => {
  const config = loadConfig({ cwd: tempDir(), home: tempDir(), env: {} })
  expect(config).toEqual({})
})

test("saveGlobalConfig creates the file and loadConfig round-trips it", () => {
  const home = tempDir()
  const path = saveGlobalConfig(
    { model: "openai/gpt-5-mini", providers: { openai: { apiKey: "sk-test" } } },
    { home },
  )
  expect(path).toContain("butterfly.jsonc")
  const config = loadConfig({ cwd: tempDir(), home, env: {} })
  expect(config.model).toBe("openai/gpt-5-mini")
  expect(config.providers?.["openai"]?.apiKey).toBe("sk-test")
})

test("saveGlobalConfig merges without clobbering existing providers", () => {
  const home = tempDir()
  saveGlobalConfig({ providers: { openrouter: { apiKey: "or-key" } } }, { home })
  saveGlobalConfig(
    { model: "openai/gpt-5-mini", providers: { openai: { apiKey: "oa-key" } } },
    { home },
  )
  const config = loadConfig({ cwd: tempDir(), home, env: {} })
  expect(config.providers?.["openrouter"]?.apiKey).toBe("or-key")
  expect(config.providers?.["openai"]?.apiKey).toBe("oa-key")
  expect(config.model).toBe("openai/gpt-5-mini")
})

test("project .butterfly/butterfly.jsonc is honored too", () => {
  const cwd = tempDir()
  mkdirSync(join(cwd, ".butterfly"), { recursive: true })
  writeFileSync(join(cwd, ".butterfly", "butterfly.jsonc"), `{ "small_model": "ollama/tiny" }`)
  const config = loadConfig({ cwd, home: tempDir(), env: {} })
  expect(config.small_model).toBe("ollama/tiny")
})

test("loadRawConfig keeps unknown keys that loadConfig would silently strip", () => {
  const cwd = tempDir()
  writeFileSync(
    join(cwd, "butterfly.jsonc"),
    `{ "model": "ollama/qwen3:8b", "notInTheSchema": 42 }`,
  )
  const raw = loadRawConfig({ cwd, home: tempDir(), env: {} }) as Record<string, unknown>
  expect(raw.notInTheSchema).toBe(42)

  const parsed = loadConfig({ cwd, home: tempDir(), env: {} }) as Record<string, unknown>
  expect(parsed.notInTheSchema).toBeUndefined()
})


test("locateHooksSource finds the most-local file that defines hooks[] (mergeConfigs replaces arrays wholesale)", () => {
  const home = tempDir()
  const cwd = tempDir()
  mkdirSync(join(home, ".config", "butterfly"), { recursive: true })
  writeFileSync(
    join(home, ".config", "butterfly", "butterfly.jsonc"),
    `{ "hooks": [{ "event": "turn.end", "command": "global-hook" }] }`,
  )
  const globalOnly = locateHooksSource({ cwd, home })
  expect(globalOnly?.scope).toBe("global")
  expect(globalOnly?.path).toBe(join(home, ".config", "butterfly", "butterfly.jsonc"))

  writeFileSync(
    join(cwd, "butterfly.jsonc"),
    `{ "hooks": [{ "event": "turn.end", "command": "project-hook" }] }`,
  )
  const projectWins = locateHooksSource({ cwd, home })
  expect(projectWins?.scope).toBe("project")
  expect(projectWins?.path).toBe(join(cwd, "butterfly.jsonc"))
})

test("hooks[].feedback round-trips through loadConfig (was silently stripped — not in the zod schema)", () => {
  const cwd = tempDir()
  writeFileSync(
    join(cwd, "butterfly.jsonc"),
    JSON.stringify({
      hooks: [{ event: "post.tool", match: "edit", command: "npm run lint", feedback: true }],
    }),
  )
  const config = loadConfig({ cwd, home: tempDir(), env: {} })
  expect(config.hooks?.[0]?.feedback).toBe(true)
})

test("locateHooksSource returns undefined when no config file defines hooks[]", () => {
  expect(locateHooksSource({ cwd: tempDir(), home: tempDir() })).toBeUndefined()
})

test("setHookEnabled rewrites a comment-free config file and preserves unrelated keys", () => {
  const cwd = tempDir()
  const home = tempDir()
  writeFileSync(
    join(cwd, "butterfly.jsonc"),
    JSON.stringify({
      model: "openrouter/x",
      hooks: [{ event: "post.tool", match: "edit", command: "npm run lint" }],
    }),
  )
  const result = setHookEnabled(0, false, { cwd, home })
  expect(result.ok).toBe(true)
  expect(result.scope).toBe("project")
  const config = loadConfig({ cwd, home, env: {} })
  expect(config.hooks?.[0]?.enabled).toBe(false)
  expect(config.hooks?.[0]?.command).toBe("npm run lint")
  expect(config.model).toBe("openrouter/x")
})

test("setHookEnabled toggles a disabled hook back to enabled", () => {
  const cwd = tempDir()
  const home = tempDir()
  writeFileSync(
    join(cwd, "butterfly.jsonc"),
    JSON.stringify({ hooks: [{ event: "post.tool", command: "x", enabled: false }] }),
  )
  const result = setHookEnabled(0, true, { cwd, home })
  expect(result.ok).toBe(true)
  const config = loadConfig({ cwd, home, env: {} })
  expect(config.hooks?.[0]?.enabled).toBe(true)
})

test("setHookEnabled fails soft on a commented file — never corrupts it, offers a snippet instead", () => {
  const cwd = tempDir()
  const home = tempDir()
  const original = `{
  // lint on every edit
  "hooks": [{ "event": "post.tool", "match": "edit", "command": "npm run lint" }]
}`
  writeFileSync(join(cwd, "butterfly.jsonc"), original)
  const result = setHookEnabled(0, false, { cwd, home })
  expect(result.ok).toBe(false)
  expect(result.snippet).toContain("npm run lint")
  expect(result.snippet).toContain("enabled")
  const after = readFileSync(join(cwd, "butterfly.jsonc"), "utf8")
  expect(after).toBe(original)
})


test("setPermissionRule creates butterfly.jsonc and the rule round-trips through loadConfig", () => {
  const cwd = tempDir()
  const result = setPermissionRule("bash", "git *", { cwd, home: tempDir() })
  expect(result.ok).toBe(true)
  expect(result.path).toBe(join(cwd, "butterfly.jsonc"))
  const config = loadConfig({ cwd, home: tempDir(), env: {} })
  expect(config.permissions?.["bash"]).toEqual({ "git *": "allow" })
})

test("setPermissionRule merges into an existing permissions tree without clobbering other keys", () => {
  const cwd = tempDir()
  const home = tempDir()
  writeFileSync(
    join(cwd, "butterfly.jsonc"),
    JSON.stringify({
      model: "openrouter/x",
      permissions: { "*": "allow", edit: { "*": "ask", ".env*": "deny" } },
    }),
  )
  const result = setPermissionRule("bash", "git *", { cwd, home })
  expect(result.ok).toBe(true)
  const config = loadConfig({ cwd, home, env: {} })
  expect(config.model).toBe("openrouter/x")
  expect(config.permissions?.["bash"]).toEqual({ "git *": "allow" })
  expect(config.permissions?.["edit"]).toEqual({ "*": "ask", ".env*": "deny" })
  expect(config.permissions?.["*"]).toBe("allow")
})

test("setPermissionRule converts a blanket tool string in the FILE into a map, preserving it as *", () => {
  const cwd = tempDir()
  const home = tempDir()
  writeFileSync(join(cwd, "butterfly.jsonc"), JSON.stringify({ permissions: { bash: "ask" } }))
  const result = setPermissionRule("bash", "git *", { cwd, home })
  expect(result.ok).toBe(true)
  const config = loadConfig({ cwd, home, env: {} })
  expect(config.permissions?.["bash"]).toEqual({ "*": "ask", "git *": "allow" })
})

test("setPermissionRule fails soft on a commented project file — never corrupts it, offers a snippet", () => {
  const cwd = tempDir()
  const home = tempDir()
  const original = `{
  // deliberately hand-annotated
  "permissions": { "bash": "ask" }
}`
  writeFileSync(join(cwd, "butterfly.jsonc"), original)
  const result = setPermissionRule("bash", "git *", { cwd, home })
  expect(result.ok).toBe(false)
  expect(result.snippet).toContain("bash")
  expect(result.snippet).toContain("git *")
  const after = readFileSync(join(cwd, "butterfly.jsonc"), "utf8")
  expect(after).toBe(original)
})
