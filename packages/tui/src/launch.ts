import { createRequire } from "node:module"

const require = createRequire(import.meta.url)


export function tuiEntrypoint(): string {
  return require.resolve("./main.tsx")
}

export function solidPreloadPath(): string {
  return require.resolve("@opentui/solid/preload")
}
