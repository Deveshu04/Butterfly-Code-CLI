#!/usr/bin/env bun
// Sets one version everywhere: bun scripts/release/bump.ts 0.2.0
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const version = process.argv[2]
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) {
  console.error("usage: bun scripts/release/bump.ts <semver>")
  process.exit(1)
}
const ROOT = join(import.meta.dir, "..", "..")
const files = [
  ...["core", "tui", "cli"].map((name) => join(ROOT, "packages", name, "package.json")),
  join(ROOT, "npm", "butterfly-code", "package.json"),
]
for (const file of files) {
  const pkg = JSON.parse(readFileSync(file, "utf8"))
  pkg.version = version
  if (pkg.optionalDependencies) {
    for (const name of Object.keys(pkg.optionalDependencies)) {
      if (name.startsWith("butterfly-code-")) pkg.optionalDependencies[name] = version
    }
  }
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
}
console.log(`version set to ${version}; commit, then tag v${version} and push the tag`)
