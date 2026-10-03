import { createRequire } from "node:module"
import { z } from "zod"
import {
  defaultAssetCacheRoot,
  extractEmbeddedAsset,
  isCompiledExecutable,
} from "../../platform/embedded-assets"
import { VERSION } from "../../version"
import type { ToolDefinition } from "../registry"
import { collectBounded } from "../shell"

const require = createRequire(import.meta.url)

export const grepInput = z.object({
  pattern: z.string().describe("Regular expression to search for (ripgrep syntax)"),
  path: z.string().optional().describe("File or directory to search (defaults to cwd)"),
  glob: z.string().optional().describe('Filter files by glob, e.g. "*.ts"'),
  ignoreCase: z.boolean().optional().describe("Case-insensitive search"),
})

export const GREP_MAX_MATCHES = 100

const EMBEDDED_RIPGREP_IMPORTERS: Record<string, () => Promise<{ default: string }>> = {
  "win32-x64": () => import("@vscode/ripgrep-win32-x64/bin/rg.exe", { with: { type: "file" } }),
}

async function resolveEmbeddedRipgrep(): Promise<string | undefined> {
  if (!isCompiledExecutable()) return undefined
  const importer = EMBEDDED_RIPGREP_IMPORTERS[`${process.platform}-${process.arch}`]
  if (!importer) return undefined
  try {
    const mod = await importer()
    const bytes = new Uint8Array(await Bun.file(mod.default).arrayBuffer())
    return await extractEmbeddedAsset(
      {
        name: process.platform === "win32" ? "rg.exe" : "rg",
        size: bytes.byteLength,
        bytes: () => bytes,
      },
      { cacheRoot: defaultAssetCacheRoot(), version: VERSION, executable: true },
    )
  } catch {
    return undefined
  }
}

export async function resolveRipgrep(): Promise<string> {
  const embedded = await resolveEmbeddedRipgrep()
  if (embedded) return embedded
  const system = Bun.which("rg")
  if (system) return system
  try {
    const { rgPath } = require("@vscode/ripgrep") as { rgPath: string }
    return rgPath
  } catch {
    throw new Error(
      "ripgrep not found. Install it (winget install BurntSushi.ripgrep.MSVC / brew install ripgrep) so it is on PATH.",
    )
  }
}

/** Matched lines wider than this are cut (minified bundles, lockfiles, data). */
export const GREP_MAX_COLUMNS = 300

/**
 * rg prints backslash path separators on Windows — normalize just the path
 * part. A drive-letter path (`C:\repo\a.ts:12:…`, from an absolute `path`
 * argument) has its first colon inside the path, so skip past it.
 */
export function normalizeLine(line: string): string {
  const from = /^[A-Za-z]:[\\/]/.test(line) ? 2 : 0
  const colon = line.indexOf(":", from)
  if (colon < 0) return line
  return line.slice(0, colon).replaceAll("\\", "/") + line.slice(colon)
}

export const grepTool: ToolDefinition<z.infer<typeof grepInput>> = {
  name: "grep",
  description:
    "Search file contents with ripgrep. Returns matching lines as path:line:text, capped at 100 matches. Respects .gitignore; node_modules and .git are always excluded.",
  inputSchema: grepInput,
  async execute(input, ctx) {
    const rg = await resolveRipgrep()
    const args = [
      "--line-number",
      "--no-heading",
      "--color",
      "never",
      "--max-count",
      "50",
      // One minified line can be 100k+ chars and would swallow the whole
      // output budget; rg keeps a preview prefix and says how much it cut.
      "--max-columns",
      String(GREP_MAX_COLUMNS),
      "--max-columns-preview",
      "-g",
      "!node_modules/**",
      "-g",
      "!.git/**",
      "-g",
      "!dist/**",
      "-g",
      "!.butterfly/**",
    ]
    if (input.ignoreCase) args.push("-i")
    else args.push("--smart-case")
    if (input.glob) args.push("-g", input.glob)
    args.push("--", input.pattern, input.path ?? ".")

    const proc = Bun.spawn([rg, ...args], {
      cwd: ctx.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      collectBounded(proc.stdout),
      collectBounded(proc.stderr),
      proc.exited,
    ])

    if (exitCode === 1) {
      return {
        output: `No matches for "${input.pattern}"${input.glob ? ` in ${input.glob}` : ""}.`,
      }
    }
    if (exitCode !== 0) {
      return { output: `ripgrep failed (exit ${exitCode}): ${stderr.trim()}`, isError: true }
    }

    const lines = stdout.trimEnd().split("\n").map(normalizeLine)
    const shown = lines.slice(0, GREP_MAX_MATCHES)
    const hidden = lines.length - shown.length
    const suffix = hidden > 0 ? `\n[... ${hidden} more matches not shown — narrow the pattern]` : ""
    return { output: `${shown.join("\n")}${suffix}` }
  },
}
