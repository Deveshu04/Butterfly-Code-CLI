import { readFileSync } from "node:fs"
import { Language, Parser, Query } from "web-tree-sitter"
import {
  grammarWasmPath,
  type LanguageSpec,
  languageForPath,
  runtimeWasmPath,
  tagsQueryPath,
} from "./languages"

export interface Tag {
  kind: "def" | "ref"
  name: string
  /** function | method | class | interface | type | enum | module | call | … */
  symbolKind: string
  row: number
  endRow: number
}

interface LoadedLanguage {
  language: Language
  query: Query
  parser: Parser
}

let initialized = false
const cache = new Map<string, LoadedLanguage | null>()

async function loadLanguage(spec: LanguageSpec): Promise<LoadedLanguage | null> {
  const cached = cache.get(spec.id)
  if (cached !== undefined) return cached

  try {
    if (!initialized) {
      await Parser.init({ locateFile: () => runtimeWasmPath() })
      initialized = true
    }
    const language = await Language.load(new Uint8Array(readFileSync(grammarWasmPath(spec))))
    const query = new Query(language, readFileSync(tagsQueryPath(spec), "utf8"))
    const parser = new Parser()
    parser.setLanguage(language)
    const loaded: LoadedLanguage = { language, query, parser }
    cache.set(spec.id, loaded)
    return loaded
  } catch {
    cache.set(spec.id, null)
    return null
  }
}

export function specForPath(path: string): LanguageSpec | undefined {
  return languageForPath(path)
}

export async function scanFile(path: string, source: string): Promise<Tag[] | null> {
  const spec = languageForPath(path)
  if (!spec) return null
  const loaded = await loadLanguage(spec)
  if (!loaded) return null

  const tree = loaded.parser.parse(source)
  if (!tree) return null

  try {
    const tags: Tag[] = []
    for (const match of loaded.query.matches(tree.rootNode)) {
      let name: { text: string; row: number } | undefined
      let kind: "def" | "ref" | undefined
      let symbolKind = ""
      let endRow = 0

      for (const capture of match.captures) {
        if (capture.name.startsWith("name.definition.")) {
          kind = "def"
          symbolKind = capture.name.slice("name.definition.".length)
          name = { text: capture.node.text, row: capture.node.startPosition.row }
        } else if (capture.name.startsWith("name.reference.")) {
          kind = "ref"
          symbolKind = capture.name.slice("name.reference.".length)
          name = { text: capture.node.text, row: capture.node.startPosition.row }
        } else if (
          capture.name.startsWith("definition.") ||
          capture.name.startsWith("reference.")
        ) {
          endRow = Math.max(endRow, capture.node.endPosition.row)
        }
      }

      if (name && kind) {
        tags.push({
          kind,
          name: name.text,
          symbolKind,
          row: name.row,
          endRow: Math.max(endRow, name.row),
        })
      }
    }
    return tags
  } finally {
    tree.delete()
  }
}

/** Free cached parsers/queries (tests, shutdown). */
export function disposeScanners(): void {
  for (const loaded of cache.values()) {
    if (!loaded) continue
    loaded.query.delete()
    loaded.parser.delete()
  }
  cache.clear()
}
