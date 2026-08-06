import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"


export interface EmbeddedAssetSource {
  /** Cache filename, e.g. "tree-sitter-typescript.wasm" or "rg.exe". */
  name: string
  size?: number
  bytes(): Promise<Uint8Array> | Uint8Array
}

export interface ExtractCacheOptions {
  cacheRoot: string
  version: string
  executable?: boolean
}

function isValidCacheHit(target: string, expectedSize?: number): boolean {
  try {
    const stat = statSync(target)
    if (!stat.isFile()) return false
    if (stat.size === 0) return false
    if (expectedSize !== undefined && stat.size !== expectedSize) return false
    return true
  } catch {
    return false
  }
}

/** Distinguishes concurrent extractions of the same asset within one process. */
let scratchCounter = 0

export function publishExtraction(
  scratch: string,
  target: string,
  expectedSize: number | undefined,
  rename: (from: string, to: string) => void = renameSync,
): void {
  try {
    rename(scratch, target)
  } catch (err) {
    if (!isValidCacheHit(target, expectedSize)) throw err
  }
}

export async function extractEmbeddedAsset(
  source: EmbeddedAssetSource,
  opts: ExtractCacheOptions,
): Promise<string> {
  const dir = join(opts.cacheRoot, opts.version)
  const target = join(dir, source.name)

  if (isValidCacheHit(target, source.size)) return target

  const bytes = await source.bytes()
  mkdirSync(dir, { recursive: true })
  const scratch = join(dir, `${source.name}.tmp-${process.pid}-${scratchCounter++}`)

  try {
    const fd = openSync(scratch, "w")
    try {
      writeFileSync(fd, bytes)
      try {
        fsyncSync(fd)
      } catch {
      }
    } finally {
      closeSync(fd)
    }
    if (opts.executable) {
      try {
        chmodSync(scratch, 0o755)
      } catch {
      }
    }
    publishExtraction(scratch, target, source.size ?? bytes.byteLength)
  } finally {
    rmSync(scratch, { force: true })
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
