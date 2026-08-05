import { afterAll, expect, test } from "bun:test"
import { disposeScanners, scanFile } from "../src/graph/scan"

afterAll(() => {
  disposeScanners()
})

const TS_SOURCE = `export function greet(name: string): string {
  return "hi " + name
}

export class Butterfly {
  fly(distance: number): void {
    greet("pilot")
  }
}

const answer = greet("world")
`

test("extracts TypeScript definitions with their body ranges", async () => {
  const tags = await scanFile("src/sample.ts", TS_SOURCE)
  expect(tags).not.toBeNull()
  const defs = (tags ?? []).filter((t) => t.kind === "def")
  const greet = defs.find((t) => t.name === "greet")
  expect(greet?.symbolKind).toBe("function")
  expect(greet?.row).toBe(0)
  expect(greet?.endRow).toBeGreaterThanOrEqual(2)
  const butterfly = defs.find((t) => t.name === "Butterfly")
  expect(butterfly?.symbolKind).toBe("class")
})

test("extracts TypeScript call references", async () => {
  const tags = await scanFile("src/sample.ts", TS_SOURCE)
  const refs = (tags ?? []).filter((t) => t.kind === "ref")
  expect(refs.filter((t) => t.name === "greet").length).toBeGreaterThanOrEqual(2)
})

test("extracts Python defs and refs", async () => {
  const source = `def build(x):\n    return x\n\nclass Loop:\n    def run(self):\n        return build(1)\n`
  const tags = await scanFile("loop.py", source)
  const defs = (tags ?? []).filter((t) => t.kind === "def").map((t) => t.name)
  expect(defs).toContain("build")
  expect(defs).toContain("Loop")
  const refs = (tags ?? []).filter((t) => t.kind === "ref").map((t) => t.name)
  expect(refs).toContain("build")
})

test("unsupported extensions return null", async () => {
  expect(await scanFile("README.md", "# hello")).toBeNull()
})

test("a syntactically broken file still yields partial tags without throwing", async () => {
  const tags = await scanFile("broken.ts", "function ok() { return 1 }\nfunction bad( {")
  expect(tags?.some((t) => t.name === "ok")).toBe(true)
})
