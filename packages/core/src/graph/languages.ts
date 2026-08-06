import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { defaultAssetCacheRoot, extractEmbeddedAsset, isCompiledExecutable } from "../platform/embedded-assets"
import { VERSION } from "../version"

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


type AssetImporter = () => Promise<{ default: string }>

const GRAMMAR_IMPORTERS: Record<string, AssetImporter> = {
  "tree-sitter-typescript.wasm": () =>
    import("@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm", { with: { type: "file" } }),
  "tree-sitter-tsx.wasm": () =>
    import("@vscode/tree-sitter-wasm/wasm/tree-sitter-tsx.wasm", { with: { type: "file" } }),
  "tree-sitter-javascript.wasm": () =>
    import("@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm", { with: { type: "file" } }),
  "tree-sitter-python.wasm": () =>
    import("@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm", { with: { type: "file" } }),
  "tree-sitter-go.wasm": () =>
    import("@vscode/tree-sitter-wasm/wasm/tree-sitter-go.wasm", { with: { type: "file" } }),
  "tree-sitter-rust.wasm": () =>
    import("@vscode/tree-sitter-wasm/wasm/tree-sitter-rust.wasm", { with: { type: "file" } }),
  "tree-sitter-java.wasm": () =>
    import("@vscode/tree-sitter-wasm/wasm/tree-sitter-java.wasm", { with: { type: "file" } }),
}

const TAGS_IMPORTERS: Record<string, AssetImporter> = {
  typescript: () => import("./queries/typescript-tags.scm", { with: { type: "file" } }),
  javascript: () => import("./queries/javascript-tags.scm", { with: { type: "file" } }),
  python: () => import("./queries/python-tags.scm", { with: { type: "file" } }),
  go: () => import("./queries/go-tags.scm", { with: { type: "file" } }),
  rust: () => import("./queries/rust-tags.scm", { with: { type: "file" } }),
  java: () => import("./queries/java-tags.scm", { with: { type: "file" } }),
}

const RUNTIME_WASM_IMPORTER: AssetImporter = () =>
  import("web-tree-sitter/web-tree-sitter.wasm", { with: { type: "file" } })

async function resolveEmbedded(name: string, importer: AssetImporter | undefined): Promise<string | undefined> {
  if (!importer || !isCompiledExecutable()) return undefined
  try {
    const mod = await importer()
    const bytes = new Uint8Array(await Bun.file(mod.default).arrayBuffer())
    return await extractEmbeddedAsset(
      { name, bytes: () => bytes },
      { cacheRoot: defaultAssetCacheRoot(), version: VERSION },
    )
  } catch {
    return undefined
  }
}

export async function resolveGrammarWasmPath(spec: LanguageSpec): Promise<string> {
  return (await resolveEmbedded(spec.grammar, GRAMMAR_IMPORTERS[spec.grammar])) ?? grammarWasmPath(spec)
}

export async function resolveRuntimeWasmPath(): Promise<string> {
  return (await resolveEmbedded("web-tree-sitter.wasm", RUNTIME_WASM_IMPORTER)) ?? runtimeWasmPath()
}

export async function resolveTagsQueryPath(spec: LanguageSpec): Promise<string> {
  return (await resolveEmbedded(`${spec.tags}-tags.scm`, TAGS_IMPORTERS[spec.tags])) ?? tagsQueryPath(spec)
}
