import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"


export interface EmbeddedAssetSource {
  /** Cache filename, e.g. "tree-sitter-typescript.wasm" or "rg.exe". */
  name: string
  bytes(): Promise<Uint8Array> | Uint8Array
}

export interface ExtractCacheOptions {
  cacheRoot: string
  version: string
  executable?: boolean
}

function isValidCacheHit(target: string): boolean {
  if (!existsSync(target)) return false
  try {
    return statSync(target).size > 0
  } catch {
    return false
  }
}

export async function extractEmbeddedAsset(
  source: EmbeddedAssetSource,
  opts: ExtractCacheOptions,
): Promise<string> {
  const dir = join(opts.cacheRoot, opts.version)
  const target = join(dir, source.name)

  if (isValidCacheHit(target)) return target

  const bytes = await source.bytes()
  mkdirSync(dir, { recursive: true })
  writeFileSync(target, bytes)
  if (opts.executable) {
    try {
      chmodSync(target, 0o755)
    } catch {
    }
  }
  return target
}

export function defaultAssetCacheRoot(home?: string): string {
  const resolvedHome = home ?? process.env["USERPROFILE"] ?? process.env["HOME"] ?? ""
  return join(resolvedHome, ".cache", "butterfly", "assets")
}

export function isCompiledExecutable(): boolean {
  return Bun.embeddedFiles.length > 0
}
