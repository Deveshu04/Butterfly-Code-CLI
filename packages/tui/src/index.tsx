import { loadConfig, reapAllBackgroundTasks } from "@butterfly/core"
import { createCliRenderer } from "@opentui/core"
import { render } from "@opentui/solid"
import { App, clearTerminalProgress } from "./app"
import { installWin32ConsoleGuard } from "./terminal-win32"

export { fitsWordmark, renderWordmark, wordmarkMode } from "./wordmark"

/**
 * Boot the full-screen TUI. render() resolves at mount, not exit, so this
 * blocks on the renderer's "destroy" event. A crash restores the terminal
 * from the alternate screen before the error prints.
 */
export async function startTui(opts: { cwd: string; home?: string }): Promise<void> {
  const config = loadConfig({ cwd: opts.cwd })
  const stopConsoleGuard = installWin32ConsoleGuard()

  const renderer = await createCliRenderer({
    targetFps: 60,
    exitOnCtrlC: false,
    autoFocus: false,
    useKittyKeyboard: {},
    openConsoleOnError: true,
  })

  const crash = (error: unknown) => {
    try {
      renderer.destroy()
    } catch {
      // terminal may already be restored
    }
    clearTerminalProgress()
    // A crash never reaches /quit's reap, so stop background tasks here.
    // Synchronous, never throws; keepAlive tasks are spared.
    reapAllBackgroundTasks()
    stopConsoleGuard()
    console.error(
      "\nbutterfly crashed:",
      error instanceof Error ? (error.stack ?? error.message) : error,
    )
    process.exit(1)
  }
  process.on("uncaughtException", crash)
  process.on("unhandledRejection", crash)

  await render(() => <App cwd={opts.cwd} config={config} home={opts.home} />, renderer)

  // Keep the process alive until the app asks the renderer to shut down
  // (/quit, Ctrl+C when idle). Exit is then clean: alternate screen restored.
  await new Promise<void>((resolve) => {
    if (renderer.isDestroyed) resolve()
    else renderer.on("destroy", () => resolve())
  })
  // destroy() restored the screen but not the OSC 9;4 progress indicator a
  // mid-turn quit may have left running.
  clearTerminalProgress()
  // Backstop for exits that skipped /quit's reap. Idempotent.
  reapAllBackgroundTasks()
  stopConsoleGuard()
}
