import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  COMMANDS,
  commandHints,
  commandMatches,
  commandMatchLabel,
  commandMatchReason,
  editDistance,
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


test("help wraps every long description with a hanging indent instead of overflowing the usage column", () => {
  const help = renderHelp()
  const lines = help.split("\n")
  const reviewIndex = lines.findIndex((line) => line.trimStart().startsWith("/review"))
  expect(reviewIndex).toBeGreaterThan(-1)
  const reviewLine = lines[reviewIndex] ?? ""
  expect(reviewLine).toContain("read-only subagent review")
  const usageIndent = reviewLine.match(/^\s*/)?.[0].length ?? 0
  for (let i = reviewIndex + 1; i < lines.length && !/^\s*\/\w/.test(lines[i] ?? ""); i++) {
    const line = lines[i] ?? ""
    if (line.trim() === "") break
    const indent = line.match(/^\s*/)?.[0].length ?? 0
    expect(indent).toBeGreaterThan(usageIndent)
  }
})

test("an oversized usage (/loop) gets its own line — never crowds or truncates the description", () => {
  const help = renderHelp()
  const lines = help.split("\n")
  const loopIndex = lines.findIndex((line) => line.trimStart().startsWith("/loop"))
  expect(loopIndex).toBeGreaterThan(-1)
  expect(lines[loopIndex]?.trim()).toBe("/loop plan <goal> | run [--allow-dirty] | status")
  // The description starts on the very next line, indented under it.
  const next = lines[loopIndex + 1] ?? ""
  expect(next.trim().length).toBeGreaterThan(0)
  expect(next.startsWith("    ")).toBe(true)
})

test("the keys line is one key per row, not a 3-line wall of text", () => {
  const help = renderHelp()
  expect(help).toContain("keys:")
  expect(help).toContain("Ctrl+C interrupts, twice quits")
  expect(help).toContain("Ctrl+O opens the transcript pager")
  const lines = help.split("\n")
  const ctrlCLine = lines.find((line) => line.includes("Ctrl+C interrupts"))
  expect(ctrlCLine).not.toContain("Ctrl+O")
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

test("/provider is registered with a /providers alias", () => {
  expect(COMMANDS.some((c) => c.name === "provider")).toBe(true)
  const alias = findCommand("/providers")
  expect(alias && "command" in alias ? alias.command.name : "").toBe("provider")
})

test("/provider with no arg dispatches to CommandActions.pickProvider", () => {
  const match = findCommand("/provider")
  expect(match && "command" in match ? match.arg : "x").toBe("")

  const calls: string[] = []
  const actions = {
    pickProvider: () => calls.push("picked"),
    selectProvider: (name: string) => calls.push(`select:${name}`),
  } as unknown as Parameters<(typeof COMMANDS)[number]["run"]>[1]
  if (match && "command" in match) void match.command.run(match.arg, actions)
  expect(calls).toEqual(["picked"])
})

test("/provider <name> dispatches to CommandActions.selectProvider with the trimmed name", () => {
  const match = findCommand("/provider  openai ")
  expect(match && "command" in match ? match.arg : "").toBe("openai")

  const calls: string[] = []
  const actions = {
    pickProvider: () => calls.push("picked"),
    selectProvider: (name: string) => calls.push(`select:${name}`),
  } as unknown as Parameters<(typeof COMMANDS)[number]["run"]>[1]
  if (match && "command" in match) void match.command.run(match.arg, actions)
  expect(calls).toEqual(["select:openai"])
})


test("commandMatches surfaces /resume for /res, and prefix rows still show", () => {
  expect(commandMatches("/res")[0]?.name).toBe("resume")
  expect(commandMatches("/rev").map((c) => c.name)).toContain("review")
})

test("commandMatches never double-lists a command that matches by both name and alias", () => {
  const matches = commandMatches("/provider")
  expect(matches.filter((c) => c.name === "provider").length).toBe(1)
})

test("commandMatchLabel prefers the alias that actually matched the draft over the primary name", () => {
  const resume = COMMANDS.find((c) => c.name === "resume")
  if (!resume) throw new Error("resume command missing")
  expect(commandMatchLabel(resume, "/cont")).toBe("continue")
  expect(commandMatchLabel(resume, "/res")).toBe("resume")
  // A keyword hit labels with the real name — Tab must complete to something dispatchable.
  expect(commandMatchLabel(resume, "/history")).toBe("resume")
})

test("synonym keywords surface and dispatch the command people meant", () => {
  const cases: [string, string][] = [
    ["/history", "resume"],
    ["/llm", "model"],
    ["/revert", "undo"],
    ["/checkpoint", "rewind"],
    ["/summarize", "compact"],
    ["/jobs", "tasks"],
    ["/autopilot", "loop"],
    ["/sarvam", "provider"],
  ]
  for (const [typed, expected] of cases) {
    expect(commandMatches(typed)[0]?.name).toBe(expected)
    const match = findCommand(`${typed} extra`)
    expect(match && "command" in match ? match.command.name : "").toBe(expected)
    if (match && "command" in match) expect(match.arg).toBe("extra")
  }
  expect(commandMatchReason(COMMANDS.find((c) => c.name === "resume") as never, "/history")).toBe(
    'matches "history"',
  )
})

test("typos rank the intended command first but only suggest (never auto-dispatch)", () => {
  expect(commandMatches("/modle")[0]?.name).toBe("model")
  expect(commandMatches("/hepl")[0]?.name).toBe("help")
  expect(commandMatches("/resmue")[0]?.name).toBe("resume")
  const typo = findCommand("/modle")
  expect(typo && "suggestions" in typo ? typo.suggestions[0]?.name : "").toBe("model")
})

test("a keyword shared by two commands never auto-dispatches", () => {
  // Construct the ambiguity from the table itself so this stays true as keywords evolve.
  const counts = new Map<string, number>()
  for (const command of COMMANDS)
    for (const k of command.keywords ?? []) counts.set(k, (counts.get(k) ?? 0) + 1)
  for (const [keyword, count] of counts) {
    if (count < 2) continue
    if (COMMANDS.some((c) => c.name === keyword || c.aliases?.includes(keyword))) continue
    const match = findCommand(`/${keyword}`)
    const prefixOwners = COMMANDS.filter(
      (c) => c.name.startsWith(keyword) || c.aliases?.some((a) => a.startsWith(keyword)),
    )
    if (prefixOwners.length === 1) continue
    expect(match && "suggestions" in match).toBe(true)
  }
})

test("paths and prose after a slash never fuzzy-match a command", () => {
  expect(commandMatches("/usr/bin/foo is broken")).toEqual([])
  expect(commandMatches("/zzz")).toEqual([])
})

test("editDistance counts adjacent transpositions as one edit", () => {
  expect(editDistance("modle", "model")).toBe(1)
  expect(editDistance("resume", "resume")).toBe(0)
  expect(editDistance("abc", "")).toBe(3)
})

test("keywords never collide with another command's name or alias", () => {
  const names = new Set(COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]))
  for (const command of COMMANDS)
    for (const keyword of command.keywords ?? []) expect(names.has(keyword)).toBe(false)
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

test("nextEffort walks the Shift+Tab cycle and wraps to the provider default", async () => {
  const { nextEffort } = await import("../src/commands")
  expect(nextEffort(undefined)).toBe("low")
  expect(nextEffort("low")).toBe("medium")
  expect(nextEffort("xhigh")).toBe("none")
  expect(nextEffort("none")).toBeUndefined()
  // Levels outside the cycle re-enter at "low".
  expect(nextEffort("minimal")).toBe("low")
})
