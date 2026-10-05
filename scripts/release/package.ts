#!/usr/bin/env bun
// Packages the binary built by scripts/build-exe.ts for the current platform:
//   dist/release/butterfly-v<version>-<target>.<tar.gz|zip>
//   dist/npm/butterfly-code-<target>/   (ready for `npm publish`)
import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { $ } from "bun"
import { currentTarget, NPM_NAME, REPO } from "./targets"
import { releaseVersion } from "./version"

const ROOT = join(import.meta.dir, "..", "..")
const target = currentTarget()
const version = releaseVersion()
const binary = join(ROOT, "dist", target.exe)
const legal = ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]

// Archive for GitHub Releases, Homebrew and Scoop.
const name = `butterfly-v${version}-${target.id}`
const stage = join(ROOT, "dist", "stage", name)
rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
copyFileSync(binary, join(stage, target.exe))
if (target.os !== "win32") chmodSync(join(stage, target.exe), 0o755)
for (const file of [...legal, "README.md"]) copyFileSync(join(ROOT, file), join(stage, file))
const outDir = join(ROOT, "dist", "release")
mkdirSync(outDir, { recursive: true })
const archive = join(outDir, `${name}.${target.archive}`)
rmSync(archive, { force: true })
if (target.archive === "zip") {
  await $`tar -a -c -f ${archive} -C ${stage} .`
} else {
  await $`tar -czf ${archive} -C ${stage} .`
}

// Platform package for npm.
const pkgName = `${NPM_NAME}-${target.id}`
const pkgDir = join(ROOT, "dist", "npm", pkgName)
rmSync(pkgDir, { recursive: true, force: true })
mkdirSync(join(pkgDir, "bin"), { recursive: true })
copyFileSync(binary, join(pkgDir, "bin", target.exe))
if (target.os !== "win32") chmodSync(join(pkgDir, "bin", target.exe), 0o755)
for (const file of legal) copyFileSync(join(ROOT, file), join(pkgDir, file))
writeFileSync(
  join(pkgDir, "package.json"),
  `${JSON.stringify(
    {
      name: pkgName,
      version,
      description: `The ${target.id} binary for ${NPM_NAME}. Install ${NPM_NAME} instead of this package.`,
      homepage: `https://github.com/${REPO}#readme`,
      repository: { type: "git", url: `git+https://github.com/${REPO}.git` },
      license: "Apache-2.0",
      os: [target.os],
      cpu: [target.cpu],
      files: [`bin/${target.exe}`, ...legal],
      preferUnplugged: true,
    },
    null,
    2,
  )}\n`,
)
writeFileSync(
  join(pkgDir, "README.md"),
  `# ${pkgName}\n\nThe ${target.id} binary of [${NPM_NAME}](https://www.npmjs.com/package/${NPM_NAME}). Install \`${NPM_NAME}\`, not this package.\n`,
)
console.log(`packaged ${archive}\npackaged ${pkgDir}`)
