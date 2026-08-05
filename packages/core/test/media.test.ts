import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  IMAGE_EXTENSIONS,
  loadImagePart,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_TURN,
  mediaTypeForPath,
  prepareImageAttachments,
  strippedImagePart,
} from "../src/context/media"

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

test("mediaTypeForPath maps every supported extension, undefined for the rest", () => {
  expect(mediaTypeForPath("a.png")).toBe("image/png")
  expect(mediaTypeForPath("a.jpg")).toBe("image/jpeg")
  expect(mediaTypeForPath("a.JPEG")).toBe("image/jpeg")
  expect(mediaTypeForPath("a.gif")).toBe("image/gif")
  expect(mediaTypeForPath("a.webp")).toBe("image/webp")
  expect(mediaTypeForPath("a.txt")).toBeUndefined()
  expect(mediaTypeForPath("a")).toBeUndefined()
  expect(IMAGE_EXTENSIONS).toContain(".png")
})

test("prepareImageAttachments hashes and resolves valid images, relative or absolute", () => {
  const cwd = tempDir("bfly-media-")
  const bytes = Buffer.from("fake-png-bytes")
  writeFileSync(join(cwd, "shot.png"), bytes)
  const expectedHash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")

  const result = prepareImageAttachments(["shot.png"], cwd)

  expect(result.notices).toEqual([])
  expect(result.images).toEqual([
    { path: join(cwd, "shot.png"), mediaType: "image/png", sha256: expectedHash },
  ])
})

test("oversized images are dropped with a notice, never thrown", () => {
  const cwd = tempDir("bfly-media-")
  writeFileSync(join(cwd, "huge.png"), Buffer.alloc(MAX_IMAGE_BYTES + 1))

  const result = prepareImageAttachments(["huge.png"], cwd)

  expect(result.images).toEqual([])
  expect(result.notices).toHaveLength(1)
  expect(result.notices[0]).toContain("huge.png")
  expect(result.notices[0]).toMatch(/5\s*MB|too large|larger/i)
})

test("more than MAX_IMAGES_PER_TURN candidates keep only the first N, rest noticed", () => {
  const cwd = tempDir("bfly-media-")
  const names = Array.from({ length: MAX_IMAGES_PER_TURN + 2 }, (_, i) => `img${i}.png`)
  for (const name of names) writeFileSync(join(cwd, name), Buffer.from(`${name}-bytes`))

  const result = prepareImageAttachments(names, cwd)

  expect(result.images).toHaveLength(MAX_IMAGES_PER_TURN)
  expect(result.notices).toHaveLength(2)
  for (const notice of result.notices) {
    expect(notice).toMatch(/max.*4.*images|per turn/i)
  }
})

test("non-image extensions and missing files are dropped with a notice", () => {
  const cwd = tempDir("bfly-media-")
  writeFileSync(join(cwd, "notes.txt"), "hello")

  const result = prepareImageAttachments(["notes.txt", "ghost.png"], cwd)

  expect(result.images).toEqual([])
  expect(result.notices).toHaveLength(2)
  expect(result.notices.join("\n")).toContain("notes.txt")
  expect(result.notices.join("\n")).toContain("ghost.png")
})

test("loadImagePart reads bytes and base64-encodes them for an existing file", () => {
  const cwd = tempDir("bfly-media-")
  const bytes = Buffer.from([1, 2, 3, 255, 0, 128])
  const path = join(cwd, "pixel.png")
  writeFileSync(path, bytes)

  const part = loadImagePart({ path, mediaType: "image/png" })

  expect(part.type).toBe("image")
  if (part.type !== "image") throw new Error("expected image part")
  expect(part.mediaType).toBe("image/png")
  expect(Buffer.from(part.data, "base64")).toEqual(bytes)
})

test("loadImagePart degrades to a placeholder text part when the file is missing at replay time", () => {
  const cwd = tempDir("bfly-media-")
  const missing = join(cwd, "gone.png")

  const part = loadImagePart({ path: missing, mediaType: "image/png" })

  expect(part.type).toBe("text")
  if (part.type !== "text") throw new Error("expected text part")
  expect(part.text).toContain(missing)
  expect(part.text.toLowerCase()).toContain("unavailable")
})

test("loadImagePart VERIFIES the journaled sha256 and sends bytes when it still matches", () => {
  const cwd = tempDir("bfly-media-")
  const bytes = Buffer.from("stable-bytes")
  const path = join(cwd, "stable.png")
  writeFileSync(path, bytes)
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")

  const part = loadImagePart({ path, mediaType: "image/png", sha256 })

  expect(part.type).toBe("image")
  if (part.type !== "image") throw new Error("expected image part")
  expect(Buffer.from(part.data, "base64")).toEqual(bytes)
})

test("loadImagePart refuses to send bytes whose sha256 no longer matches — placeholder names the file", () => {
  const cwd = tempDir("bfly-media-")
  const path = join(cwd, "edited.png")
  writeFileSync(path, Buffer.from("original-bytes"))
  const sha256 = new Bun.CryptoHasher("sha256").update(Buffer.from("original-bytes")).digest("hex")
  // The file changes on disk after being attached (edited, regenerated,
  // or a temp path reused) — the journaled hash is now stale.
  writeFileSync(path, Buffer.from("totally-different-bytes"))

  const part = loadImagePart({ path, mediaType: "image/png", sha256 })

  expect(part.type).toBe("text")
  if (part.type !== "text") throw new Error("expected text part")
  expect(part.text).toContain(path)
  expect(part.text.toLowerCase()).toContain("changed")
})

test("loadImagePart with no journaled sha256 (nothing to verify) still sends the bytes", () => {
  const cwd = tempDir("bfly-media-")
  const bytes = Buffer.from("unhashed")
  const path = join(cwd, "unhashed.png")
  writeFileSync(path, bytes)

  const part = loadImagePart({ path, mediaType: "image/png" })

  expect(part.type).toBe("image")
})

test("strippedImagePart names the file so a text-only model can still read() it", () => {
  const part = strippedImagePart({ path: "/w/shot.png" })

  expect(part.type).toBe("text")
  if (part.type !== "text") throw new Error("expected text part")
  expect(part.text).toContain("/w/shot.png")
  expect(part.text.toLowerCase()).toContain("not sent")
  expect(part.text.toLowerCase()).toContain("read")
})
