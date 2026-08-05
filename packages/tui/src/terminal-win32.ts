/**
 * Windows console guard for the full-screen TUI.
 *
 * With ENABLE_PROCESSED_INPUT set, the Windows console turns Ctrl+C into a
 * CTRL_C_EVENT that kills the process. The TUI handles Ctrl+C itself
 * (interrupt, then quit), so while it runs we clear that flag on the console
 * input handle and the key arrives as ordinary input instead.
 */

// Win32 constants (wincon.h / processenv.h).
const STD_INPUT_HANDLE = -10
const ENABLE_PROCESSED_INPUT = 0x0001
const INVALID_HANDLE_VALUE = -1n

// Terminal libraries may rewrite the console mode after startup, so the
// cleared flag is re-applied on this interval.
const REAPPLY_INTERVAL_MS = 100

const noop = (): void => {}

type Kernel32 = {
  GetStdHandle: (which: number) => bigint
  GetConsoleMode: (handle: bigint, out: Uint32Array) => number
  SetConsoleMode: (handle: bigint, mode: number) => number
}

/** Opens kernel32 via bun:ffi; returns null when either is unavailable. */
function openKernel32(): { k32: Kernel32; close: () => void } | null {
  try {
    // Required lazily so non-Windows platforms never load bun:ffi.
    const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi")
    const lib = dlopen("kernel32.dll", {
      // HANDLE is pointer-sized; i64 keeps INVALID_HANDLE_VALUE (-1) exact.
      GetStdHandle: { args: [FFIType.i32], returns: FFIType.i64 },
      GetConsoleMode: { args: [FFIType.i64, FFIType.ptr], returns: FFIType.i32 },
      SetConsoleMode: { args: [FFIType.i64, FFIType.u32], returns: FFIType.i32 },
    })
    return {
      k32: lib.symbols as unknown as Kernel32,
      close: () => lib.close(),
    }
  } catch {
    return null
  }
}

/**
 * Clears ENABLE_PROCESSED_INPUT on the console input handle while the TUI
 * runs. Returns an idempotent stop function that restores the original mode.
 * Never throws; anywhere the guard can't apply it returns a no-op.
 */
export function installWin32ConsoleGuard(): () => void {
  if (process.platform !== "win32") return noop

  const lib = openKernel32()
  if (!lib) return noop
  const { k32 } = lib

  let handle: bigint
  let original: number
  const modeBuf = new Uint32Array(1)
  try {
    handle = BigInt(k32.GetStdHandle(STD_INPUT_HANDLE))
    // NULL means no stdin handle; INVALID_HANDLE_VALUE means the call failed.
    if (handle === 0n || handle === INVALID_HANDLE_VALUE) {
      lib.close()
      return noop
    }
    // Fails when stdin isn't a console (piped or redirected).
    if (k32.GetConsoleMode(handle, modeBuf) === 0) {
      lib.close()
      return noop
    }
    original = modeBuf[0] ?? 0
  } catch {
    try {
      lib.close()
    } catch {
      // nothing left to release
    }
    return noop
  }

  // Clear only the processed-input bit so flags set by others (e.g. VT input)
  // survive each re-apply.
  const apply = (): void => {
    try {
      if (k32.GetConsoleMode(handle, modeBuf) === 0) return
      const mode = modeBuf[0] ?? 0
      if (mode & ENABLE_PROCESSED_INPUT) {
        k32.SetConsoleMode(handle, mode & ~ENABLE_PROCESSED_INPUT)
      }
    } catch {
      // best effort; the next tick tries again
    }
  }

  apply()
  const timer = setInterval(apply, REAPPLY_INTERVAL_MS)
  // Never keep the process alive just for the guard.
  timer.unref?.()

  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    try {
      k32.SetConsoleMode(handle, original)
    } catch {
      // console may already be gone at exit
    }
    try {
      lib.close()
    } catch {
      // already released
    }
  }
}
