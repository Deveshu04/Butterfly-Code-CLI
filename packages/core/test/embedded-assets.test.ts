import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  defaultAssetCacheRoot,
  type EmbeddedAssetSource,
  extractEmbeddedAsset,
  isCompiledExecutable,
} from "../src/platform/embedded-assets"

function cacheDir(): string {
  return mkdtempSync(join(tmpdir(), "bfly-asset-cache-"))
}

function counting(bytes: Uint8Array): { source: EmbeddedAssetSource; calls: () => number } {
  let calls = 0
  return {
    source: {
      name: "grammar.wasm",
      bytes: () => {
        calls++
        return bytes
      },
    },
    calls: () => calls,
  }
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
  expect(defaultAssetCacheRoot("/home/pilot")).toBe(join("/home/pilot", ".cache", "butterfly", "assets"))
})

test("isCompiledExecutable is false under bun test (never a standalone executable)", () => {
  expect(isCompiledExecutable()).toBe(false)
})
