import { expect, test } from "bun:test"
import { applyEdit } from "../src/edit/apply"

test("replaces a unique exact match", () => {
  const result = applyEdit("const a = 1\nconst b = 2\n", "const b = 2", "const b = 3")
  expect(result).toEqual({ ok: true, content: "const a = 1\nconst b = 3\n", replacements: 1 })
})

test("reports not_found with an actionable message", () => {
  const result = applyEdit("hello world", "goodbye", "farewell")
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.reason).toBe("not_found")
    expect(result.message).toContain("not found")
  }
})

test("reports ambiguous when the search matches more than once", () => {
  const result = applyEdit("x = 1\nx = 1\n", "x = 1", "x = 2")
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.reason).toBe("ambiguous")
    expect(result.message).toContain("2")
  }
})

test("replaceAll replaces every occurrence", () => {
  const result = applyEdit("x = 1\nx = 1\n", "x = 1", "x = 2", { replaceAll: true })
  expect(result).toEqual({ ok: true, content: "x = 2\nx = 2\n", replacements: 2 })
})

test("falls back to whitespace-tolerant matching on indentation drift", () => {
  const content = "function f() {\n\t\treturn 1\n}\n"
  const result = applyEdit(
    content,
    "function f() {\n  return 1\n}",
    "function f() {\n  return 2\n}",
  )
  expect(result.ok).toBe(true)
  if (result.ok) expect(result.content).toContain("return 2")
})

test("empty search on empty content creates the content", () => {
  const result = applyEdit("", "", "new file body\n")
  expect(result).toEqual({ ok: true, content: "new file body\n", replacements: 1 })
})

test("empty search on non-empty content is rejected", () => {
  const result = applyEdit("existing", "", "clobber")
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.reason).toBe("not_found")
})

test("identical search and replace is rejected as no_change", () => {
  const result = applyEdit("abc", "abc", "abc")
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.reason).toBe("no_change")
})
