#!/usr/bin/env bun
// Writes THIRD_PARTY_NOTICES.md: every production dependency bundled into the
// release binary, with its license text. Run: bun scripts/release/third-party.ts
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

const ROOT = join(import.meta.dir, "..", "..")
const WORKSPACES = ["core", "tui", "cli"].map((name) => join(ROOT, "packages", name))

interface Pkg {
  name: string
  version: string
  license?: string | { type?: string }
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  repository?: string | { url?: string }
}

const seen = new Map<string, { pkg: Pkg; dir: string }>()

function findPackageDir(name: string, fromDir: string): string | undefined {
  const require = createRequire(join(fromDir, "noop.js"))
  try {
    return dirname(realpathSync(require.resolve(`${name}/package.json`)))
  } catch {
    // Packages whose "exports" hide package.json: walk node_modules upwards.
    let dir = fromDir
    for (;;) {
      const candidate = join(dir, "node_modules", name, "package.json")
      if (existsSync(candidate)) return dirname(realpathSync(candidate))
      const parent = dirname(dir)
      if (parent === dir) return undefined
      dir = parent
    }
  }
}

function visit(dir: string, isWorkspace: boolean): void {
  if (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir)
    if (parent !== dir) visit(parent, isWorkspace)
    return
  }
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Pkg
  if (!pkg.name) {
    // A nested package.json (e.g. {"type":"module"} in dist/): use the real root.
    const parent = dirname(dir)
    if (parent !== dir) visit(parent, isWorkspace)
    return
  }
  if (!isWorkspace) {
    const key = `${pkg.name}@${pkg.version}`
    if (seen.has(key)) return
    seen.set(key, { pkg, dir })
  }
  const deps = { ...pkg.dependencies, ...pkg.optionalDependencies }
  for (const name of Object.keys(deps)) {
    if (name.startsWith("@butterfly/")) continue
    const child = findPackageDir(name, dir)
    if (child) visit(child, false)
  }
}

for (const workspace of WORKSPACES) visit(workspace, true)

function licenseOf(pkg: Pkg): string {
  if (typeof pkg.license === "string") return pkg.license
  return pkg.license?.type ?? "UNKNOWN"
}

function licenseText(dir: string): string | undefined {
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(f))
  return file ? readFileSync(join(dir, file), "utf8").replace(/\r\n?/g, "\n").trim() : undefined
}

const entries = [...seen.values()].sort((a, b) => a.pkg.name.localeCompare(b.pkg.name))
const lines: string[] = [
  "# Third-party notices",
  "",
  "Butterfly Code release binaries bundle the components below. Each is",
  "distributed under its own license, reproduced here.",
  "",
  "## Bun runtime",
  "",
  "The standalone binary embeds the Bun runtime (MIT), which statically links",
  "JavaScriptCore and parts of WebKit under the GNU LGPL 2.1, among other",
  "components. Bun's license and the corresponding source are available at",
  "https://bun.sh/docs/project/licensing and https://github.com/oven-sh/WebKit.",
  "",
  "## ripgrep",
  "",
  "The binary embeds ripgrep (MIT OR Unlicense), https://github.com/BurntSushi/ripgrep.",
  "",
  "## npm packages",
  "",
  "| Package | Version | License |",
  "|---|---|---|",
  ...entries.map(({ pkg }) => `| ${pkg.name} | ${pkg.version} | ${licenseOf(pkg)} |`),
  "",
]
for (const { pkg, dir } of entries) {
  const text = licenseText(dir)
  lines.push(`### ${pkg.name} ${pkg.version}`, "", `License: ${licenseOf(pkg)}`, "")
  if (text) lines.push("```", text, "```", "")
}
const unknown = entries.filter(({ pkg }) => licenseOf(pkg) === "UNKNOWN").map(({ pkg }) => pkg.name)
writeFileSync(join(ROOT, "THIRD_PARTY_NOTICES.md"), `${lines.join("\n")}\n`)
console.log(`THIRD_PARTY_NOTICES.md: ${entries.length} packages`)
if (unknown.length > 0) console.warn(`no license field: ${unknown.join(", ")}`)
