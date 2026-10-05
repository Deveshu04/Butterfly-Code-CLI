import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

/**
 * The Solid JSX transform is a preload Bun plugin, and Bun reads bunfig.toml
 * only from the current directory. So the CLI re-execs the TUI as
 * `bun --preload <solidPreloadPath()> <tuiEntrypoint()>` with absolute paths.
 * This module stays JSX-free so it loads without the transform.
 */

export function tuiEntrypoint(): string {
  return require.resolve("./main.tsx")
}

export function solidPreloadPath(): string {
  return require.resolve("@opentui/solid/preload")
}
