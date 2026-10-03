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

test("whitespace-tolerant fallback re-indents the replacement to the file's style", () => {
  const content = "def f():\n    if x:\n        y()\n    return 1\n"
  // The model dropped one indent level for the whole block.
  const result = applyEdit(content, "if x:\n    y()", "if x:\n    z()\n    w()")
  expect(result).toEqual({
    ok: true,
    content: "def f():\n    if x:\n        z()\n        w()\n    return 1\n",
    replacements: 1,
  })
})

test("re-indent maps tabs vs spaces and keeps deeper relative indentation", () => {
  const content = "function f() {\n\t\treturn 1\n}\n"
  const result = applyEdit(
    content,
    "function f() {\n  return 1\n}",
    "function f() {\n  if (a) {\n    return 2\n  }\n}",
  )
  expect(result.ok).toBe(true)
  if (result.ok)
    expect(result.content).toBe("function f() {\n\t\tif (a) {\n\t\t  return 2\n\t\t}\n}\n")
})

test("an inconsistent mapping falls back to line-by-line indentation for same-shape edits", () => {
  // "  a" matches a 4-space line and "  b" a 2-space line: no single mapping.
  const content = "x\n    a\n  b\n"
  const result = applyEdit(content, "x\n  a\n  b", "x\n  c\n  d")
  expect(result).toEqual({ ok: true, content: "x\n    c\n  d\n", replacements: 1 })
  // Different shape: no safe translation, the replacement goes in unchanged.
  const reshaped = applyEdit(content, "x\n  a\n  b", "x\n  c")
  expect(reshaped).toEqual({ ok: true, content: "x\n  c\n", replacements: 1 })
})

test("CRLF files stay CRLF — exact and whitespace-tolerant paths alike", () => {
  const content = "function a() {\r\n  return 1\r\n}\r\n"
  const exact = applyEdit(content, "function a() {\n  return 1\n}", "function a() {\n  return 2\n}")
  expect(exact).toEqual({
    ok: true,
    content: "function a() {\r\n  return 2\r\n}\r\n",
    replacements: 1,
  })
  const tolerant = applyEdit(content, "function a() {\nreturn 1\n}", "function a() {\nreturn 3\n}")
  expect(tolerant).toEqual({
    ok: true,
    content: "function a() {\r\n  return 3\r\n}\r\n",
    replacements: 1,
  })
  // A model that echoed the \r from read output works too.
  const echoed = applyEdit(content, "  return 1\r\n", "  return 4\r\n")
  expect(echoed.ok && echoed.content).toBe("function a() {\r\n  return 4\r\n}\r\n")
})

test("mixed line endings are left alone (no wholesale conversion)", () => {
  const content = "a\r\nb\nc\n"
  const result = applyEdit(content, "b", "B")
  expect(result).toEqual({ ok: true, content: "a\r\nB\nc\n", replacements: 1 })
})

test("ambiguity names the matching lines", () => {
  const result = applyEdit("x = 1\ny\nx = 1\n", "x = 1", "x = 2")
  expect(!result.ok && result.message).toContain("lines 1, 3")
})

test("not_found quotes the closest region with line numbers", () => {
  const content = [
    "import { a } from './a'",
    "",
    "export function total(items: Item[]): number {",
    "  let sum = 0",
    "  for (const item of items) sum += item.price",
    "  return sum",
    "}",
  ].join("\n")
  // One paraphrased line (price → cost) in an otherwise-correct block.
  const result = applyEdit(
    content,
    "  let sum = 0\n  for (const item of items) sum += item.cost\n  return sum",
    "  return items.reduce((s, i) => s + i.price, 0)",
  )
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.reason).toBe("not_found")
    expect(result.message).toContain("Closest match in the file (lines 4-6")
    expect(result.message).toContain("5\t  for (const item of items) sum += item.price")
  }
})

test("not_found without a plausible neighbour keeps the generic advice", () => {
  const result = applyEdit("alpha\nbeta\n", "completely unrelated text here", "x")
  expect(!result.ok && result.message).toContain("Re-read the file")
})
