import { expect, test } from "bun:test"
import { type PermissionRules, resolvePermission } from "../src/permission/tree"

test("defaults to ask when no rules match", () => {
  expect(resolvePermission({}, "bash", "rm -rf /")).toBe("ask")
})

test("root wildcard sets the default decision", () => {
  expect(resolvePermission({ "*": "allow" }, "read", "src/index.ts")).toBe("allow")
})

test("blanket tool rule overrides root default", () => {
  expect(resolvePermission({ "*": "allow", bash: "ask" }, "bash", "ls")).toBe("ask")
})

test("pattern rule matches the target", () => {
  const rules: PermissionRules = { "*": "ask", bash: { "git *": "allow" } }
  expect(resolvePermission(rules, "bash", "git status")).toBe("allow")
})

test("unmatched pattern falls through to root default", () => {
  const rules: PermissionRules = { "*": "deny", bash: { "git *": "allow" } }
  expect(resolvePermission(rules, "bash", "rm -rf /")).toBe("deny")
})

test("longest matching pattern wins", () => {
  const rules: PermissionRules = { bash: { "git *": "allow", "git push*": "ask" } }
  expect(resolvePermission(rules, "bash", "git push origin main")).toBe("ask")
  expect(resolvePermission(rules, "bash", "git status")).toBe("allow")
})

test("deny wins between equal-length matches", () => {
  const rules: PermissionRules = { edit: { "*.env": "deny", "?.env": "allow" } }
  expect(resolvePermission(rules, "edit", "a.env")).toBe("deny")
})

test("tool pattern map without target uses its wildcard entry", () => {
  const rules: PermissionRules = { bash: { "*": "deny" } }
  expect(resolvePermission(rules, "bash")).toBe("deny")
})

test("question-mark wildcard matches exactly one character", () => {
  const rules: PermissionRules = { edit: { "?.md": "allow" } }
  expect(resolvePermission(rules, "edit", "a.md")).toBe("allow")
  expect(resolvePermission(rules, "edit", "ab.md")).toBe("ask")
})
