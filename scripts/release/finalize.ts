#!/usr/bin/env bun
// Runs after every platform build: writes SHA256SUMS, the main npm package,
// the Homebrew formula and the Scoop manifest.
//   input:  dist/release/*.tar.gz|zip, dist/npm/butterfly-code-<target>/
//   output: dist/release/SHA256SUMS, dist/npm/butterfly-code/,
//           dist/homebrew/butterfly-code.rb, dist/scoop/butterfly-code.json
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { NPM_NAME, REPO, TARGETS, type Target } from "./targets"
import { releaseVersion } from "./version"

const ROOT = join(import.meta.dir, "..", "..")
const version = releaseVersion()
const releaseDir = join(ROOT, "dist", "release")

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(await Bun.file(path).arrayBuffer())
  return hasher.digest("hex")
}

const archiveName = (t: Target) => `butterfly-v${version}-${t.id}.${t.archive}`
const sums = new Map<string, string>()
for (const target of TARGETS) {
  const path = join(releaseDir, archiveName(target))
  if (!existsSync(path)) throw new Error(`missing ${archiveName(target)}`)
  sums.set(target.id, await sha256(path))
}
const sumLines = TARGETS.map((t) => `${sums.get(t.id)}  ${archiveName(t)}`)
writeFileSync(join(releaseDir, "SHA256SUMS"), `${sumLines.join("\n")}\n`)

// Main npm package: the launcher, pinned to this version's platform packages.
const mainDir = join(ROOT, "dist", "npm", NPM_NAME)
mkdirSync(join(mainDir, "bin"), { recursive: true })
const manifest = JSON.parse(readFileSync(join(ROOT, "npm", NPM_NAME, "package.json"), "utf8"))
manifest.version = version
manifest.optionalDependencies = Object.fromEntries(
  TARGETS.map((t) => [`${NPM_NAME}-${t.id}`, version]),
)
writeFileSync(join(mainDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
copyFileSync(
  join(ROOT, "npm", NPM_NAME, "bin", "butterfly.js"),
  join(mainDir, "bin", "butterfly.js"),
)
for (const file of ["README.md", "LICENSE", "NOTICE"]) {
  copyFileSync(join(ROOT, file), join(mainDir, file))
}
for (const target of TARGETS) {
  const dir = join(ROOT, "dist", "npm", `${NPM_NAME}-${target.id}`)
  if (!existsSync(join(dir, "package.json")))
    throw new Error(`missing npm package for ${target.id}`)
}

// Homebrew formula (for a tap repository named homebrew-tap).
const url = (t: Target) =>
  `https://github.com/${REPO}/releases/download/v${version}/${archiveName(t)}`
const brewBlock = (t: Target) => `      url "${url(t)}"\n      sha256 "${sums.get(t.id)}"`
const byId = (id: string) => TARGETS.find((t) => t.id === id) as Target
mkdirSync(join(ROOT, "dist", "homebrew"), { recursive: true })
writeFileSync(
  join(ROOT, "dist", "homebrew", "butterfly-code.rb"),
  `class ButterflyCode < Formula
  desc "Terminal coding agent with a token-efficient harness"
  homepage "https://github.com/${REPO}"
  version "${version}"
  license "Apache-2.0"

  on_macos do
    on_arm do
${brewBlock(byId("darwin-arm64"))}
    end
    on_intel do
${brewBlock(byId("darwin-x64"))}
    end
  end

  on_linux do
    on_arm do
${brewBlock(byId("linux-arm64"))}
    end
    on_intel do
${brewBlock(byId("linux-x64"))}
    end
  end

  def install
    bin.install "butterfly"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/butterfly --version")
  end
end
`,
)

// Scoop manifest (for a bucket repository).
const win = byId("windows-x64")
mkdirSync(join(ROOT, "dist", "scoop"), { recursive: true })
writeFileSync(
  join(ROOT, "dist", "scoop", "butterfly-code.json"),
  `${JSON.stringify(
    {
      version,
      description: "Terminal coding agent with a token-efficient harness",
      homepage: `https://github.com/${REPO}`,
      license: "Apache-2.0",
      architecture: { "64bit": { url: url(win), hash: sums.get(win.id) } },
      bin: "butterfly.exe",
      checkver: { github: `https://github.com/${REPO}` },
      autoupdate: {
        architecture: {
          "64bit": {
            url: `https://github.com/${REPO}/releases/download/v$version/butterfly-v$version-windows-x64.zip`,
          },
        },
      },
    },
    null,
    2,
  )}\n`,
)

console.log(readdirSync(releaseDir).join("\n"))
console.log(`npm packages and manifests ready for v${version}`)
