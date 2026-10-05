// Runnable TUI entry, run with `bun --preload @opentui/solid/preload` (see
// launch.ts). Without the preload Bun loads Solid's SSR build and mount fails.
import { startTui } from "./index"

await startTui({ cwd: process.cwd() })
