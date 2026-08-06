import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  COMMANDS,
  commandHints,
  expandTemplate,
  findCommand,
  loadCustomCommands,
  renderHelp,
} from "../src/commands"

test("exact names and aliases resolve with their argument", () => {
  const model = findCommand("/model openai/gpt-5-mini")
  expect(model && "command" in model ? model.command.name : "").toBe("model")
  expect(model && "arg" in model ? model.arg : "").toBe("openai/gpt-5-mini")

  const alias = findCommand("/clear")
  expect(alias && "command" in alias ? alias.command.name : "").toBe("new")
})

test("unique prefixes resolve, ambiguous ones suggest", () => {
  const unique = findCommand("/comp")
  expect(unique && "command" in unique ? unique.command.name : "").toBe("compact")

  const ambiguous = findCommand("/s")
  expect(
    ambiguous && "suggestions" in ambiguous ? ambiguous.suggestions.length : 0,
  ).toBeGreaterThan(1)
})

test("non-commands return null and unknowns suggest nothing", () => {
  expect(findCommand("hello")).toBeNull()
  const unknown = findCommand("/zzz")
  expect(unknown && "suggestions" in unknown ? unknown.suggestions.length : -1).toBe(0)
})

test("custom commands load from dirs with project precedence and expansion", () => {
  const project = mkdtempSync(join(tmpdir(), "bfly-cmd-p-"))
  const user = mkdtempSync(join(tmpdir(), "bfly-cmd-u-"))
  writeFileSync(
    join(project, "deploy.md"),
    "---\ndescription: Ship it safely\n---\n\nDeploy $1 to $2 with checks. Notes: $ARGUMENTS",
  )
  writeFileSync(join(user, "deploy.md"), "user version — must lose")
  writeFileSync(join(user, "triage.md"), "Triage the open issues carefully.")
  writeFileSync(join(user, "help.md"), "must be skipped — collides with a builtin")

  const commands = loadCustomCommands([project, user])
  expect(commands.map((c) => c.name)).toEqual(["deploy", "triage"])
  expect(commands[0]?.description).toBe("Ship it safely")
  expect(commands[0]?.template).toContain("Deploy $1")

  const expanded = expandTemplate(commands[0]?.template ?? "", "api staging")
  expect(expanded).toContain("Deploy api to staging")
  expect(expanded).toContain("Notes: api staging")
  expect(expandTemplate("keep $3 literal", "one two")).toBe("keep $3 literal")
})

test("help covers every command and hints narrow while typing", () => {
  const help = renderHelp()
  for (const command of COMMANDS) expect(help).toContain(`/${command.name}`)
  expect(commandHints("/th")).toContain("/think")
  expect(commandHints("/th")).not.toContain("/help")
  expect(commandHints("plain text")).toBe("")
})

test("/review is registered and dispatches with its range/--staged argument", () => {
  expect(COMMANDS.some((c) => c.name === "review")).toBe(true)
  const bare = findCommand("/review")
  expect(bare && "command" in bare ? bare.command.name : "").toBe("review")
  expect(bare && "command" in bare ? bare.arg : "x").toBe("")

  const withRange = findCommand("/review HEAD~3")
  expect(withRange && "command" in withRange ? withRange.command.name : "").toBe("review")
  expect(withRange && "command" in withRange ? withRange.arg : "").toBe("HEAD~3")

  const staged = findCommand("/review --staged")
  expect(staged && "command" in staged ? staged.arg : "").toBe("--staged")
})

test("/commit is registered and dispatches with no argument", () => {
  expect(COMMANDS.some((c) => c.name === "commit")).toBe(true)
  const match = findCommand("/commit")
  expect(match && "command" in match ? match.command.name : "").toBe("commit")
})

test("/review and /commit each invoke their CommandActions method with the parsed arg", () => {
  const calls: { name: string; arg: string }[] = []
  const actions = {
    review: async (arg: string) => {
      calls.push({ name: "review", arg })
    },
    commit: async () => {
      calls.push({ name: "commit", arg: "" })
    },
  } as unknown as Parameters<(typeof COMMANDS)[number]["run"]>[1]

  const review = findCommand("/review HEAD~1")
  if (review && "command" in review) void review.command.run(review.arg, actions)
  const commit = findCommand("/commit")
  if (commit && "command" in commit) void commit.command.run(commit.arg, actions)

  expect(calls).toEqual([
    { name: "review", arg: "HEAD~1" },
    { name: "commit", arg: "" },
  ])
})

test("/handoff is registered and invokes CommandActions.handoff", () => {
  expect(COMMANDS.some((c) => c.name === "handoff")).toBe(true)
  const match = findCommand("/handoff")
  expect(match && "command" in match ? match.command.name : "").toBe("handoff")

  let called = 0
  const actions = {
    handoff: async () => {
      called += 1
    },
  } as unknown as Parameters<(typeof COMMANDS)[number]["run"]>[1]
  if (match && "command" in match) void match.command.run(match.arg, actions)
  expect(called).toBe(1)
})

test("/paste-img is registered and invokes CommandActions.pasteImage", () => {
  expect(COMMANDS.some((c) => c.name === "paste-img")).toBe(true)
  const match = findCommand("/paste-img")
  expect(match && "command" in match ? match.command.name : "").toBe("paste-img")

  let called = 0
  const actions = {
    pasteImage: async () => {
      called += 1
    },
  } as unknown as Parameters<(typeof COMMANDS)[number]["run"]>[1]
  if (match && "command" in match) void match.command.run(match.arg, actions)
  expect(called).toBe(1)
})
