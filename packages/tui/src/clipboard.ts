import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"

/**
 * Windows clipboard image shim: PowerShell's `Get-Clipboard -Format Image`
 * saves the image to `.butterfly/media/<ts>.png`. Fail-soft: no image, no
 * `powershell.exe`, or a timeout all resolve to `null`, never throw.
 */

const CLIPBOARD_TIMEOUT_MS = 10_000

type SpawnFn = (cmd: string[]) => { exited: Promise<number>; kill: () => void }

export interface SaveClipboardImageDeps {
  spawn?: SpawnFn
  now?: () => number
}

function defaultSpawn(cmd: string[]) {
  return Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
}

export async function saveClipboardImage(
  cwd: string,
  deps: SaveClipboardImageDeps = {},
): Promise<string | null> {
  const now = deps.now ?? Date.now
  const spawn = deps.spawn ?? defaultSpawn
  const mediaDir = join(cwd, ".butterfly", "media")
  try {
    mkdirSync(mediaDir, { recursive: true })
  } catch {
    return null
  }
  const outPath = join(mediaDir, `${now()}.png`)
  // PowerShell single-quoted string: escape ' by doubling it.
  const escaped = outPath.replaceAll("'", "''")
  const script = `$ErrorActionPreference='Stop'; $img = Get-Clipboard -Format Image; if ($img -eq $null) { exit 1 }; $img.Save('${escaped}')`

  try {
    const proc = spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script])
    const timedOut = await Promise.race([
      proc.exited.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), CLIPBOARD_TIMEOUT_MS)),
    ])
    if (timedOut) {
      try {
        proc.kill()
      } catch {
        // best-effort — the 10s cap is the real backstop
      }
      return null
    }
    const exitCode = await proc.exited
    if (exitCode !== 0) return null
    return existsSync(outPath) ? outPath : null
  } catch {
    return null
  }
}

/**
 * Mouse select-to-copy goes through OpenTUI's `renderer.copyToClipboardOSC52`,
 * which encodes, writes, and checks terminal support itself. This module only
 * applies a size cap: some terminals and multiplexers (tmux, some xterm
 * builds) drop or mangle oversized OSC 52 payloads.
 */

/** The cap in base64 bytes (what terminals limit). Other figures derive from it. */
export const OSC52_BASE64_CAP = 100_000

/** Raw UTF-8 bytes that fit under the base64 cap (a multiple of 3, so no padding). */
export const OSC52_TEXT_CAP_BYTES = Math.floor(OSC52_BASE64_CAP / 4) * 3

/** Approximate text cap for the truncation notice, e.g. `"~73KB"`. */
export function osc52CapLabel(): string {
  return `~${Math.round(OSC52_TEXT_CAP_BYTES / 1024)}KB`
}

export interface Osc52Payload {
  /** Selection text trimmed to the cap, for `renderer.copyToClipboardOSC52`. */
  text: string
  /** True when the selection was trimmed; callers should say so. */
  truncated: boolean
}

/**
 * Trims `text` to fit under `capBase64Bytes` once base64-encoded. The cut
 * backs off past UTF-8 continuation bytes (at most 3) so it never splits a
 * character.
 */
export function capOsc52Text(
  text: string,
  capBase64Bytes: number = OSC52_BASE64_CAP,
): Osc52Payload {
  const bytes = Buffer.from(text, "utf-8")
  const budget = Math.floor(capBase64Bytes / 4) * 3
  if (bytes.length <= budget) return { text, truncated: false }
  let end = budget
  // `?? 0` only satisfies noUncheckedIndexedAccess; `end` is always in range.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--
  return { text: bytes.subarray(0, end).toString("utf-8"), truncated: true }
}
