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
