import { expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  defaultAssetCacheRoot,
  type EmbeddedAssetSource,
  extractEmbeddedAsset,
  isCompiledExecutable,
  publishExtraction,
} from "../src/platform/embedded-assets"

function cacheDir(): string {
  return mkdtempSync(join(tmpdir(), "bfly-asset-cache-"))
}

function counting(
  bytes: Uint8Array,
  size?: number,
): { source: EmbeddedAssetSource; calls: () => number } {
  let calls = 0
  return {
    source: {
      name: "grammar.wasm",
      ...(size === undefined ? {} : { size }),
      bytes: () => {
        calls++
        return bytes
      },
    },
    calls: () => calls,
  }
}

/** Leftover scratch files from a non-atomic or half-cleaned extraction. */
function tmpLitter(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((name) => name.includes(".tmp-"))
}

test("absent: extracts from the source and writes the cache file", async () => {
  const root = cacheDir()
  const { source, calls } = counting(new TextEncoder().encode("wasm-bytes"))
  const target = await extractEmbeddedAsset(source, { cacheRoot: root, version: "1.0.0" })

  expect(target).toBe(join(root, "1.0.0", "grammar.wasm"))
  expect(existsSync(target)).toBe(true)
  expect(readFileSync(target, "utf8")).toBe("wasm-bytes")
  expect(calls()).toBe(1)
})

test("present: a valid non-empty cache file is returned without re-reading the source", async () => {
  const root = cacheDir()
  const { source, calls } = counting(new TextEncoder().encode("wasm-bytes"))

  const first = await extractEmbeddedAsset(source, { cacheRoot: root, version: "1.0.0" })
  expect(calls()).toBe(1)

  const second = await extractEmbeddedAsset(source, { cacheRoot: root, version: "1.0.0" })
  expect(second).toBe(first)
  expect(calls()).toBe(1) // skip re-extraction — source.bytes() not called again
})

test("corrupt: a zero-byte cache file is treated as absent and re-extracted", async () => {
  const root = cacheDir()
  const dir = join(root, "1.0.0")
  const target = join(dir, "grammar.wasm")
  mkdirSync(dir, { recursive: true })
  writeFileSync(target, "")
  expect(existsSync(target)).toBe(true)

  const { source, calls } = counting(new TextEncoder().encode("fresh-bytes"))
  const result = await extractEmbeddedAsset(source, { cacheRoot: root, version: "1.0.0" })

  expect(result).toBe(target)
  expect(readFileSync(target, "utf8")).toBe("fresh-bytes")
  expect(calls()).toBe(1)
})

test("version keying: different versions get independent cache entries", async () => {
  const root = cacheDir()
  const v1 = counting(new TextEncoder().encode("v1-bytes"))
  const v2 = counting(new TextEncoder().encode("v2-bytes"))

  const p1 = await extractEmbeddedAsset(v1.source, { cacheRoot: root, version: "1.0.0" })
  const p2 = await extractEmbeddedAsset(v2.source, { cacheRoot: root, version: "2.0.0" })

  expect(p1).not.toBe(p2)
  expect(readFileSync(p1, "utf8")).toBe("v1-bytes")
  expect(readFileSync(p2, "utf8")).toBe("v2-bytes")
})

test("supports an async source (bytes() returning a Promise)", async () => {
  const root = cacheDir()
  const source: EmbeddedAssetSource = {
    name: "rg.exe",
    bytes: async () => new TextEncoder().encode("async-bytes"),
  }
  const target = await extractEmbeddedAsset(source, { cacheRoot: root, version: "1.0.0" })
  expect(readFileSync(target, "utf8")).toBe("async-bytes")
})

test("executable: true does not throw when writing a binary-flagged asset", async () => {
  const root = cacheDir()
  const source: EmbeddedAssetSource = {
    name: "rg.exe",
    bytes: () => new TextEncoder().encode("binary"),
  }
  const target = await extractEmbeddedAsset(source, {
    cacheRoot: root,
    version: "1.0.0",
    executable: true,
  })
  expect(existsSync(target)).toBe(true)
})

test("defaultAssetCacheRoot joins home/.cache/butterfly/assets", () => {
  expect(defaultAssetCacheRoot("/home/pilot")).toBe(
    join("/home/pilot", ".cache", "butterfly", "assets"),
  )
})

test("isCompiledExecutable is false under bun test (never a standalone executable)", () => {
  expect(isCompiledExecutable()).toBe(false)
})

// Atomic publish: partial files are never trusted, first-run races are safe

test("a successful extraction leaves no scratch/tmp files behind", async () => {
  const root = cacheDir()
  const { source } = counting(new TextEncoder().encode("wasm-bytes"))
  await extractEmbeddedAsset(source, { cacheRoot: root, version: "1.0.0" })

  expect(tmpLitter(join(root, "1.0.0"))).toEqual([])
})

test("self-heal: a partially-written cache file (non-zero, wrong size) is re-extracted", async () => {
  const root = cacheDir()
  const dir = join(root, "1.0.0")
  const target = join(dir, "grammar.wasm")
  mkdirSync(dir, { recursive: true })
  writeFileSync(target, "wasm-by") // half of "wasm-bytes": non-zero, so size>0 alone trusts it

  const full = new TextEncoder().encode("wasm-bytes")
  const { source, calls } = counting(full, full.byteLength)
  const result = await extractEmbeddedAsset(source, { cacheRoot: root, version: "1.0.0" })

  expect(result).toBe(target)
  expect(readFileSync(target, "utf8")).toBe("wasm-bytes")
  expect(calls()).toBe(1)
  expect(tmpLitter(dir)).toEqual([])
})

test("a cache file whose size matches the declared size is a hit (source never read)", async () => {
  const root = cacheDir()
  const dir = join(root, "1.0.0")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "grammar.wasm"), "wasm-bytes")

  const full = new TextEncoder().encode("wasm-bytes")
  const { source, calls } = counting(full, full.byteLength)
  await extractEmbeddedAsset(source, { cacheRoot: root, version: "1.0.0" })

  expect(calls()).toBe(0)
})

test("without a declared size, any non-empty cache file is trusted (documented limit)", async () => {
  const root = cacheDir()
  const dir = join(root, "1.0.0")
  const target = join(dir, "grammar.wasm")
  mkdirSync(dir, { recursive: true })
  writeFileSync(target, "wasm-by")

  const { source, calls } = counting(new TextEncoder().encode("wasm-bytes"))
  await extractEmbeddedAsset(source, { cacheRoot: root, version: "1.0.0" })

  expect(readFileSync(target, "utf8")).toBe("wasm-by")
  expect(calls()).toBe(0)
})

test("a directory at the target path is never a cache hit, and the failure cleans up", async () => {
  const root = cacheDir()
  const dir = join(root, "1.0.0")
  mkdirSync(join(dir, "grammar.wasm"), { recursive: true })

  const { source, calls } = counting(new TextEncoder().encode("wasm-bytes"))
  await expect(
    extractEmbeddedAsset(source, { cacheRoot: root, version: "1.0.0" }),
  ).rejects.toThrow()

  expect(calls()).toBe(1) // not treated as a hit
  expect(statSync(join(dir, "grammar.wasm")).isDirectory()).toBe(true)
  expect(tmpLitter(dir)).toEqual([])
})

test("a source that fails to yield bytes writes nothing at all", async () => {
  const root = cacheDir()
  const source: EmbeddedAssetSource = {
    name: "grammar.wasm",
    bytes: async () => {
      throw new Error("embedded read failed")
    },
  }
  await expect(extractEmbeddedAsset(source, { cacheRoot: root, version: "1.0.0" })).rejects.toThrow(
    "embedded read failed",
  )

  expect(existsSync(join(root, "1.0.0", "grammar.wasm"))).toBe(false)
  expect(tmpLitter(join(root, "1.0.0"))).toEqual([])
})

test("concurrent extractions in one process all resolve to the same intact file", async () => {
  const root = cacheDir()
  const payload = "wasm-bytes-".repeat(2000)
  const source: EmbeddedAssetSource = {
    name: "grammar.wasm",
    size: payload.length,
    bytes: async () => {
      await Bun.sleep(1)
      return new TextEncoder().encode(payload)
    },
  }
  const opts = { cacheRoot: root, version: "1.0.0" }
  const results = await Promise.all([
    extractEmbeddedAsset(source, opts),
    extractEmbeddedAsset(source, opts),
    extractEmbeddedAsset(source, opts),
  ])

  expect(new Set(results).size).toBe(1)
  expect(readFileSync(results[0] as string, "utf8")).toBe(payload)
  expect(tmpLitter(join(root, "1.0.0"))).toEqual([])
})

test("publishExtraction: a lost rename race with a valid target present is a success", () => {
  const dir = cacheDir()
  const tmp = join(dir, "grammar.wasm.tmp-1-0")
  const target = join(dir, "grammar.wasm")
  writeFileSync(tmp, "mine")
  writeFileSync(target, "theirs") // the other process published first and holds it open

  expect(() =>
    publishExtraction(tmp, target, "theirs".length, () => {
      const err = new Error("EPERM: operation not permitted, rename") as Error & { code?: string }
      err.code = "EPERM"
      throw err
    }),
  ).not.toThrow()
  expect(readFileSync(target, "utf8")).toBe("theirs")
})

test("publishExtraction: a rename failure with no valid target rethrows and publishes nothing", () => {
  const dir = cacheDir()
  const tmp = join(dir, "grammar.wasm.tmp-1-0")
  const target = join(dir, "grammar.wasm")
  writeFileSync(tmp, "mine")

  expect(() =>
    publishExtraction(tmp, target, "mine".length, () => {
      throw new Error("ENOSPC: no space left on device, rename")
    }),
  ).toThrow("ENOSPC")
  // The killed-mid-publish case: a half-done extraction is never visible at the real path.
  expect(existsSync(target)).toBe(false)
})

test("publishExtraction: a lost race against a size-mismatched target still rethrows", () => {
  const dir = cacheDir()
  const tmp = join(dir, "grammar.wasm.tmp-1-0")
  const target = join(dir, "grammar.wasm")
  writeFileSync(tmp, "full-bytes")
  writeFileSync(target, "full") // truncated leftover, not a legitimate winner

  expect(() =>
    publishExtraction(tmp, target, "full-bytes".length, () => {
      throw new Error("EPERM: operation not permitted, rename")
    }),
  ).toThrow("EPERM")
})
