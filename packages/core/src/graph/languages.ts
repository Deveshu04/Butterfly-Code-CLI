import { createRequire } from "node:module"
import { dirname, join } from "node:path"

const require = createRequire(import.meta.url)

export interface LanguageSpec {
  /** Registry id, also the tags query filename prefix. */
  id: string
  /** Grammar wasm filename inside @vscode/tree-sitter-wasm. */
  grammar: string
  tags: string
  extensions: string[]
}

export const LANGUAGES: LanguageSpec[] = [
  {
    id: "typescript",
    grammar: "tree-sitter-typescript.wasm",
    tags: "typescript",
    extensions: [".ts", ".mts", ".cts"],
  },
  { id: "tsx", grammar: "tree-sitter-tsx.wasm", tags: "typescript", extensions: [".tsx"] },
  {
    id: "javascript",
    grammar: "tree-sitter-javascript.wasm",
    tags: "javascript",
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
  },
  { id: "python", grammar: "tree-sitter-python.wasm", tags: "python", extensions: [".py"] },
  { id: "go", grammar: "tree-sitter-go.wasm", tags: "go", extensions: [".go"] },
  { id: "rust", grammar: "tree-sitter-rust.wasm", tags: "rust", extensions: [".rs"] },
  { id: "java", grammar: "tree-sitter-java.wasm", tags: "java", extensions: [".java"] },
]

export function languageForPath(path: string): LanguageSpec | undefined {
  const lower = path.toLowerCase()
  return LANGUAGES.find((lang) => lang.extensions.some((ext) => lower.endsWith(ext)))
}

export function grammarWasmPath(spec: LanguageSpec): string {
  const pkg = require.resolve("@vscode/tree-sitter-wasm/package.json")
  return join(dirname(pkg), "wasm", spec.grammar)
}

export function runtimeWasmPath(): string {
  return require.resolve("web-tree-sitter/web-tree-sitter.wasm")
}

export function tagsQueryPath(spec: LanguageSpec): string {
  return join(import.meta.dir, "queries", `${spec.tags}-tags.scm`)
}
