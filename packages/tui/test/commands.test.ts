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

test("/tasks with no arg lists background tasks via CommandActions.tasksText", () => {
  expect(COMMANDS.some((c) => c.name === "tasks")).toBe(true)
  const match = findCommand("/tasks")
  expect(match && "command" in match ? match.command.name : "").toBe("tasks")
  expect(match && "command" in match ? match.arg : "x").toBe("")

  const calls: string[] = []
  const actions = {
    tasksText: () => "no background tasks this session.",
    info: (text: string) => calls.push(text),
  } as unknown as Parameters<(typeof COMMANDS)[number]["run"]>[1]
  if (match && "command" in match) void match.command.run(match.arg, actions)
  expect(calls).toEqual(["no background tasks this session."])
})

test("/tasks kill <id> dispatches to CommandActions.killTask with the id", () => {
  const match = findCommand("/tasks kill abc12345")
  expect(match && "command" in match ? match.command.name : "").toBe("tasks")
  expect(match && "command" in match ? match.arg : "").toBe("kill abc12345")

  const calls: string[] = []
  const actions = {
    killTask: (id: string) => calls.push(id),
    error: () => {},
  } as unknown as Parameters<(typeof COMMANDS)[number]["run"]>[1]
  if (match && "command" in match) void match.command.run(match.arg, actions)
  expect(calls).toEqual(["abc12345"])
})

test("/tasks show <id> dispatches to CommandActions.showTask and surfaces its text via info", () => {
  const match = findCommand("/tasks show abc12345")
  const calls: string[] = []
  const actions = {
    showTask: (id: string) => `task ${id}: exited (0)`,
    info: (text: string) => calls.push(text),
  } as unknown as Parameters<(typeof COMMANDS)[number]["run"]>[1]
  if (match && "command" in match) void match.command.run(match.arg, actions)
  expect(calls).toEqual(["task abc12345: exited (0)"])
})

test("/tasks with an unrecognized sub-verb reports usage via error, not a crash", () => {
  const match = findCommand("/tasks frobnicate abc12345")
  const errors: string[] = []
  const actions = {
    error: (text: string) => errors.push(text),
  } as unknown as Parameters<(typeof COMMANDS)[number]["run"]>[1]
  if (match && "command" in match) void match.command.run(match.arg, actions)
  expect(errors.length).toBe(1)
  expect(errors[0]).toContain("/tasks")
})

test("/loop with no arg (or 'status') shows loopStatusText via info", () => {
  expect(COMMANDS.some((c) => c.name === "loop")).toBe(true)
  const bare = findCommand("/loop")
  expect(bare && "command" in bare ? bare.command.name : "").toBe("loop")

  const calls: string[] = []
  const actions = {
    loopStatusText: () => "loop queue: {}",
    info: (text: string) => calls.push(text),
  } as unknown as Parameters<(typeof COMMANDS)[number]["run"]>[1]
  if (bare && "command" in bare) void bare.command.run(bare.arg, actions)

  const status = findCommand("/loop status")
  if (status && "command" in status) void status.command.run(status.arg, actions)

  expect(calls).toEqual(["loop queue: {}", "loop queue: {}"])
})

test("/loop plan <goal> dispatches to CommandActions.loopPlan with the goal text", () => {
  const match = findCommand("/loop plan fix the flaky test")
  expect(match && "command" in match ? match.arg : "").toBe("plan fix the flaky test")

  const calls: string[] = []
  const actions = {
    loopPlan: async (goal: string) => {
      calls.push(goal)
    },
  } as unknown as Parameters<(typeof COMMANDS)[number]["run"]>[1]
  if (match && "command" in match) void match.command.run(match.arg, actions)
  expect(calls).toEqual(["fix the flaky test"])
})

test("/loop plan with no goal reports usage via error, not a crash", () => {
  const match = findCommand("/loop plan")
  const errors: string[] = []
  const actions = {
    error: (text: string) => errors.push(text),
  } as unknown as Parameters<(typeof COMMANDS)[number]["run"]>[1]
  if (match && "command" in match) void match.command.run(match.arg, actions)
  expect(errors.length).toBe(1)
  expect(errors[0]).toContain("/loop plan")
})

test("/loop run dispatches to CommandActions.loopRun with allowDirty false", () => {
  const match = findCommand("/loop run")
  const calls: boolean[] = []
  const actions = {
    loopRun: async (allowDirty: boolean) => {
      calls.push(allowDirty)
    },
  } as unknown as Parameters<(typeof COMMANDS)[number]["run"]>[1]
  if (match && "command" in match) void match.command.run(match.arg, actions)
  expect(calls).toEqual([false])
})

test("/loop run --allow-dirty is an EXPLICIT opt-out, passed through to loopRun", () => {
  const match = findCommand("/loop run --allow-dirty")
  const calls: boolean[] = []
  const actions = {
    loopRun: async (allowDirty: boolean) => {
      calls.push(allowDirty)
    },
  } as unknown as Parameters<(typeof COMMANDS)[number]["run"]>[1]
  if (match && "command" in match) void match.command.run(match.arg, actions)
  expect(calls).toEqual([true])
})

test("/loop run with an unknown flag errors instead of silently ignoring it", () => {
  const match = findCommand("/loop run --force")
  const errors: string[] = []
  const actions = {
    error: (text: string) => errors.push(text),
    loopRun: async () => {
      throw new Error("must not start a loop on an unrecognized flag")
    },
  } as unknown as Parameters<(typeof COMMANDS)[number]["run"]>[1]
  if (match && "command" in match) void match.command.run(match.arg, actions)
  expect(errors.length).toBe(1)
  expect(errors[0]).toContain("--allow-dirty")
})

test("/loop with an unrecognized sub-verb reports usage via error, not a crash", () => {
  const match = findCommand("/loop frobnicate")
  const errors: string[] = []
  const actions = {
    error: (text: string) => errors.push(text),
  } as unknown as Parameters<(typeof COMMANDS)[number]["run"]>[1]
  if (match && "command" in match) void match.command.run(match.arg, actions)
  expect(errors.length).toBe(1)
  expect(errors[0]).toContain("/loop")
})

test("/theme with no arg opens the picker via CommandActions.pickTheme", () => {
  expect(COMMANDS.some((c) => c.name === "theme")).toBe(true)
  const match = findCommand("/theme")
  expect(match && "command" in match ? match.command.name : "").toBe("theme")
  expect(match && "command" in match ? match.arg : "x").toBe("")

  const calls: string[] = []
  const actions = {
    pickTheme: () => calls.push("picked"),
    setTheme: (name: string) => calls.push(`set:${name}`),
  } as unknown as Parameters<(typeof COMMANDS)[number]["run"]>[1]
  if (match && "command" in match) void match.command.run(match.arg, actions)
  expect(calls).toEqual(["picked"])
})

test("/theme <name> dispatches to CommandActions.setTheme with the trimmed name", () => {
  const match = findCommand("/theme  light ")
  expect(match && "command" in match ? match.arg : "").toBe("light")

  const calls: string[] = []
  const actions = {
    pickTheme: () => calls.push("picked"),
    setTheme: (name: string) => calls.push(`set:${name}`),
  } as unknown as Parameters<(typeof COMMANDS)[number]["run"]>[1]
  if (match && "command" in match) void match.command.run(match.arg, actions)
  expect(calls).toEqual(["set:light"])
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
