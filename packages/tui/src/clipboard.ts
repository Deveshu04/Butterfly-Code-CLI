import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"


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


export const OSC52_BASE64_CAP = 100_000

export const OSC52_TEXT_CAP_BYTES = Math.floor(OSC52_BASE64_CAP / 4) * 3

export function osc52CapLabel(): string {
  return `~${Math.round(OSC52_TEXT_CAP_BYTES / 1024)}KB`
}

export interface Osc52Payload {
  text: string
  truncated: boolean
}

export function capOsc52Text(
  text: string,
  capBase64Bytes: number = OSC52_BASE64_CAP,
): Osc52Payload {
  const bytes = Buffer.from(text, "utf-8")
  const budget = Math.floor(capBase64Bytes / 4) * 3
  if (bytes.length <= budget) return { text, truncated: false }
  let end = budget
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--
  return { text: bytes.subarray(0, end).toString("utf-8"), truncated: true }
}
