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

/**
 * Compiled-exe asset embedding. Files that must be spawned (ripgrep) are
 * extracted to a version-keyed cache dir via a temp file and one atomic
 * rename, so a racing or interrupted run never leaves a truncated file.
 */

/** Supplies an embedded asset's bytes; only read on a cache miss. */
export interface EmbeddedAssetSource {
  /** Cache filename, e.g. "tree-sitter-typescript.wasm" or "rg.exe". */
  name: string
  /** Expected byte length. When given, a cached file must match it exactly,
   * which repairs a truncated cache; otherwise any non-empty file is trusted. */
  size?: number
  bytes(): Promise<Uint8Array> | Uint8Array
}

export interface ExtractCacheOptions {
  /** Root cache dir; a `<version>` subdirectory is appended. */
  cacheRoot: string
  version: string
  /** chmod 0o755 before publishing (best-effort). */
  executable?: boolean
}

/**
 * A usable prior extraction: a non-empty regular file of `expectedSize`
 * bytes when given. The size check still matters with atomic publishing:
 * power loss or external truncation can leave a partial file.
 */
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

/**
 * Publishes the scratch file at `target` with one atomic rename. On Windows
 * the rename fails if another process already published and holds the file
 * open; since its bytes are identical, a valid target counts as success.
 *
 * @internal `rename` is injectable for tests.
 */
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

/**
 * Returns `<cacheRoot>/<version>/<name>`, extracting `source.bytes()` there
 * only when no usable prior extraction exists.
 */
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
        fsyncSync(fd) // durable before the rename exposes it
      } catch {
        // Some filesystems reject fsync on regular files.
      }
    } finally {
      closeSync(fd)
    }
    if (opts.executable) {
      try {
        chmodSync(scratch, 0o755) // before publish, so it is never non-executable
      } catch {
        // Irrelevant on Windows.
      }
    }
    publishExtraction(scratch, target, source.size ?? bytes.byteLength)
  } finally {
    rmSync(scratch, { force: true }) // cleans up failure paths
  }

  return target
}

/** `~/.cache/butterfly/assets`. */
export function defaultAssetCacheRoot(home?: string): string {
  const resolvedHome = home ?? process.env["USERPROFILE"] ?? process.env["HOME"] ?? ""
  return join(resolvedHome, ".cache", "butterfly", "assets")
}

/** True only inside a `bun build --compile` executable; `Bun.embeddedFiles`
 * is empty everywhere else. */
export function isCompiledExecutable(): boolean {
  return Bun.embeddedFiles.length > 0
}
