#!/usr/bin/env node
// Launcher for the prebuilt `butterfly` binary. npm installs exactly one
// platform package (butterfly-code-<os>-<arch>) through optionalDependencies;
// this script finds it and runs it with the same arguments.
"use strict"

const { spawn } = require("node:child_process")
const { existsSync } = require("node:fs")
const path = require("node:path")

const PLATFORMS = {
  "linux-x64": "butterfly-code-linux-x64",
  "linux-arm64": "butterfly-code-linux-arm64",
  "darwin-x64": "butterfly-code-darwin-x64",
  "darwin-arm64": "butterfly-code-darwin-arm64",
  "win32-x64": "butterfly-code-windows-x64",
}

function binaryPath() {
  const override = process.env.BUTTERFLY_BINARY
  if (override) return override
  const key = `${process.platform}-${process.arch}`
  const pkg = PLATFORMS[key]
  if (!pkg) {
    fail(
      `butterfly-code has no prebuilt binary for ${key}.\n` +
        "Supported: " +
        Object.keys(PLATFORMS).join(", ") +
        ".\n" +
        "You can run it from source with Bun instead: https://github.com/Deveshu04/Butterfly-Code-CLI#from-source",
    )
  }
  const exe = process.platform === "win32" ? "butterfly.exe" : "butterfly"
  try {
    return require.resolve(`${pkg}/bin/${exe}`)
  } catch {
    // Some package managers place optional dependencies next to this package.
    const sibling = path.join(__dirname, "..", "..", pkg, "bin", exe)
    if (existsSync(sibling)) return sibling
    fail(
      `The platform package ${pkg} is not installed.\n` +
        "It is an optional dependency, so it is skipped when installs run with --no-optional\n" +
        "or --omit=optional. Reinstall with: npm install -g butterfly-code",
    )
  }
}

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

const child = spawn(binaryPath(), process.argv.slice(2), { stdio: "inherit" })
// The terminal delivers Ctrl+C to the whole process group, so the child sees
// it directly; the launcher only relays signals sent to it alone.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (signal !== "SIGINT") child.kill(signal)
  })
}
child.on("error", (error) => fail(`Could not start butterfly: ${error.message}`))
child.on("exit", (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal)
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
