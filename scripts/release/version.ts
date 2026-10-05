import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..", "..")

/** The version every package shares; a release tag must equal `v<version>`. */
export function releaseVersion(): string {
  const versions = ["core", "tui", "cli"].map(
    (name) =>
      (
        JSON.parse(readFileSync(join(ROOT, "packages", name, "package.json"), "utf8")) as {
          version: string
        }
      ).version,
  )
  const launcher = (
    JSON.parse(readFileSync(join(ROOT, "npm", "butterfly-code", "package.json"), "utf8")) as {
      version: string
    }
  ).version
  const all = new Set([...versions, launcher])
  if (all.size !== 1) throw new Error(`package versions disagree: ${[...all].join(", ")}`)
  const version = versions[0] as string
  const tag = process.env.GITHUB_REF_NAME
  if (tag?.startsWith("v") && tag !== `v${version}`) {
    throw new Error(`tag ${tag} does not match package version ${version}`)
  }
  return version
}
