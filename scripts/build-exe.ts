#!/usr/bin/env bun
import { mkdirSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import type { BunPlugin } from "bun"

const ROOT = join(import.meta.dir, "..")
const OUT_DIR = join(ROOT, "dist")
const OUT_FILE = join(OUT_DIR, process.platform === "win32" ? "butterfly.exe" : "butterfly")

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true })

  const tuiRequire = createRequire(join(ROOT, "packages", "tui", "package.json"))
  const solidPluginPath = tuiRequire.resolve("@opentui/solid/bun-plugin")
  const { default: solidTransformPlugin } = (await import(solidPluginPath)) as {
    default: BunPlugin
  }

  // The grep tool imports the virtual module "butterfly:ripgrep"; point it at
  // this platform's ripgrep binary so the bundler embeds it.
  const coreRequire = createRequire(join(ROOT, "packages", "core", "package.json"))
  const { rgPath } = (await import(coreRequire.resolve("@vscode/ripgrep"))) as { rgPath: string }
  const ripgrepPlugin: BunPlugin = {
    name: "butterfly-ripgrep",
    setup(build) {
      build.onResolve({ filter: /^butterfly:ripgrep$/ }, () => ({ path: rgPath }))
    },
  }

  const result = await Bun.build({
    entrypoints: [join(ROOT, "packages", "cli", "src", "index.ts")],
    target: "bun",
    plugins: [solidTransformPlugin, ripgrepPlugin],
    compile: {
      outfile: OUT_FILE,
    },
  })

  if (!result.success) {
    for (const message of result.logs) console.error(String(message))
    console.error("\nbuild:exe failed")
    process.exit(1)
  }

  for (const message of result.logs) console.warn(String(message))

  const size = await Bun.file(OUT_FILE).size
  const mb = (size / (1024 * 1024)).toFixed(1)
  console.log(`built ${OUT_FILE} (${mb} MB)`)
}

await main()
