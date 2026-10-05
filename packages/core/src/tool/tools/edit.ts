import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, extname, isAbsolute, join } from "node:path"
import { z } from "zod"
import { applyEdit } from "../../edit/apply"
import type { ToolDefinition } from "../registry"

export const editInput = z.object({
  file_path: z.string().describe("Absolute or cwd-relative path to the file"),
  old_string: z
    .string()
    .describe(
      "Exact text to replace (include 3+ surrounding lines for uniqueness). Empty string creates a new file.",
    ),
  new_string: z.string().describe("Replacement text"),
  replace_all: z.boolean().optional().describe("Replace every occurrence"),
})

/** Syntactically invalid TS/JS edits are rejected before they hit disk. */
export const SYNTAX_GATED_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]

function loaderFor(ext: string): "ts" | "tsx" | "js" | "jsx" {
  if (ext === ".tsx") return "tsx"
  if (ext === ".jsx") return "jsx"
  if (ext === ".ts") return "ts"
  return "js"
}

export const editTool: ToolDefinition<z.infer<typeof editInput>> = {
  name: "edit",
  description:
    "Edit a file via exact search/replace. old_string must match the file exactly (whitespace included); empty old_string creates a new file. TS/JS edits are syntax-checked before writing.",
  inputSchema: editInput,
  permissionTarget: (input) => input.file_path,
  async execute(input, ctx) {
    const path = isAbsolute(input.file_path) ? input.file_path : join(ctx.cwd, input.file_path)

    let existing: string | null = null
    try {
      existing = readFileSync(path, "utf8")
    } catch {
      existing = null
    }

    if (existing === null && input.old_string !== "") {
      return {
        output: `File not found: ${input.file_path}. To create a new file, pass an empty old_string.`,
        isError: true,
      }
    }

    const result = applyEdit(existing ?? "", input.old_string, input.new_string, {
      replaceAll: input.replace_all,
    })
    if (!result.ok) {
      return { output: `Edit rejected (${result.reason}): ${result.message}`, isError: true }
    }

    const ext = extname(path).toLowerCase()
    if (SYNTAX_GATED_EXTENSIONS.includes(ext)) {
      try {
        new Bun.Transpiler({ loader: loaderFor(ext) }).transformSync(result.content)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          output: `Edit rejected: the change would produce a syntax error — ${message}. The file was left unchanged; fix new_string and retry.`,
          isError: true,
        }
      }
    }

    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, result.content)
    const plural = result.replacements === 1 ? "" : "s"

    // UI-only diff of the changed region; the model sees only the line above.
    const oldLines = input.old_string === "" ? [] : input.old_string.split("\n")
    const newLines = input.new_string === "" ? [] : input.new_string.split("\n")
    const diff = [
      `--- a/${input.file_path}`,
      `+++ b/${input.file_path}`,
      `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
      ...oldLines.map((line) => `-${line}`),
      ...newLines.map((line) => `+${line}`),
    ].join("\n")

    return {
      output: `Edited ${input.file_path} (${result.replacements} replacement${plural}).`,
      meta: { diff, path: input.file_path },
    }
  },
}
