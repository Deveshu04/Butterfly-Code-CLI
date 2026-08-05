import { existsSync, readFileSync, statSync } from "node:fs"
import { extname, isAbsolute, resolve } from "node:path"


const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

export const IMAGE_EXTENSIONS = Object.keys(MEDIA_TYPES)

/** ~5MB per image. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
/** Max images attachable in a single turn. */
export const MAX_IMAGES_PER_TURN = 4

export function mediaTypeForPath(path: string): string | undefined {
  return MEDIA_TYPES[extname(path).toLowerCase()]
}

export function isImagePath(path: string): boolean {
  return mediaTypeForPath(path) !== undefined
}

export interface ImageRef {
  path: string
  mediaType: string
  sha256: string
}

export interface PrepareImagesResult {
  images: ImageRef[]
  notices: string[]
}

function sha256(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(bytes)
  return hasher.digest("hex")
}

export function prepareImageAttachments(paths: string[], cwd: string): PrepareImagesResult {
  const images: ImageRef[] = []
  const notices: string[] = []

  for (const raw of paths) {
    if (images.length >= MAX_IMAGES_PER_TURN) {
      notices.push(`${raw}: skipped — max ${MAX_IMAGES_PER_TURN} images per turn`)
      continue
    }
    const abs = isAbsolute(raw) ? raw : resolve(cwd, raw)
    const mediaType = mediaTypeForPath(abs)
    if (!mediaType) {
      notices.push(`${raw}: skipped — not a supported image type (${IMAGE_EXTENSIONS.join(", ")})`)
      continue
    }
    if (!existsSync(abs)) {
      notices.push(`${raw}: skipped — file not found`)
      continue
    }
    let size: number
    try {
      size = statSync(abs).size
    } catch {
      notices.push(`${raw}: skipped — could not read file`)
      continue
    }
    if (size > MAX_IMAGE_BYTES) {
      notices.push(`${raw}: skipped — larger than ${Math.floor(MAX_IMAGE_BYTES / (1024 * 1024))}MB`)
      continue
    }
    let bytes: Buffer
    try {
      bytes = readFileSync(abs)
    } catch {
      notices.push(`${raw}: skipped — could not read file`)
      continue
    }
    images.push({ path: abs, mediaType, sha256: sha256(bytes) })
  }

  return { images, notices }
}

export type LoadedImagePart =
  | { type: "image"; mediaType: string; data: string }
  | { type: "text"; text: string }

export function loadImagePart(image: {
  path: string
  mediaType: string
  sha256?: string
}): LoadedImagePart {
  let bytes: Buffer
  try {
    bytes = readFileSync(image.path)
  } catch {
    return { type: "text", text: `[image unavailable: ${image.path}]` }
  }
  if (image.sha256 !== undefined && sha256(bytes) !== image.sha256) {
    return {
      type: "text",
      text: `[image changed on disk since it was attached: ${image.path} — not sent (its contents no longer match the attached image); re-attach it if you still need it]`,
    }
  }
  return { type: "image", mediaType: image.mediaType, data: bytes.toString("base64") }
}

export function strippedImagePart(image: { path: string }): LoadedImagePart {
  return {
    type: "text",
    text: `[image attached: ${image.path} — not sent (the current model does not support image input); use the read tool if the file is textual]`,
  }
}
