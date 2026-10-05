import { expect, test } from "bun:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { type AttentionAction, clearProgressOsc } from "@butterfly/core"
import {
  applyHeadlessAttention,
  clearHeadlessProgress,
  installProgressExitClear,
} from "../src/attention-headless"

function fakeStream(isTTY: boolean) {
  const written: string[] = []
  return {
    isTTY,
    write: (chunk: string) => {
      written.push(chunk)
      return true
    },
    written,
  }
}

const actions: AttentionAction[] = [
  { type: "title", text: "busy — repo", osc: "\x1b]0;busy — repo\x07" },
  { type: "progress", osc: "\x1b]9;4;3;0\x07" },
  {
    type: "notify",
    message: "turn finished",
    title: "butterfly code",
    osc: "\x1b]9;turn finished\x07",
  },
]

test("writes each action's raw OSC to the stream, in order, when it is a TTY", () => {
  const stream = fakeStream(true)
  applyHeadlessAttention(actions, stream)
  expect(stream.written).toEqual(actions.map((a) => a.osc))
})

test("writes nothing when the stream is not a TTY (piped/redirected stderr stays clean)", () => {
  const stream = fakeStream(false)
  applyHeadlessAttention(actions, stream)
  expect(stream.written).toEqual([])
})

test("an empty action list writes nothing even on a TTY", () => {
  const stream = fakeStream(true)
  applyHeadlessAttention([], stream)
  expect(stream.written).toEqual([])
})

// abnormal termination: the progress indicator must never outlive us

test("clearHeadlessProgress writes the OSC 9;4;0 clear on a TTY, nothing when piped", () => {
  const tty = fakeStream(true)
  clearHeadlessProgress(tty)
  expect(tty.written).toEqual([clearProgressOsc()])

  const piped = fakeStream(false)
  clearHeadlessProgress(piped)
  expect(piped.written).toEqual([])
})

test("installProgressExitClear registers exit + signal hooks and uninstall removes them", () => {
  const before = {
    exit: process.listenerCount("exit"),
    sigint: process.listenerCount("SIGINT"),
    sigterm: process.listenerCount("SIGTERM"),
  }
  const uninstall = installProgressExitClear(fakeStream(true))
  expect(process.listenerCount("exit")).toBe(before.exit + 1)
  expect(process.listenerCount("SIGINT")).toBe(before.sigint + 1)
  expect(process.listenerCount("SIGTERM")).toBe(before.sigterm + 1)
  uninstall()
  expect(process.listenerCount("exit")).toBe(before.exit)
  expect(process.listenerCount("SIGINT")).toBe(before.sigint)
  expect(process.listenerCount("SIGTERM")).toBe(before.sigterm)
})

test("the exit hook writes the clear at most once, however many times it fires", () => {
  const stream = fakeStream(true)
  const uninstall = installProgressExitClear(stream)
  process.emit("exit", 0)
  process.emit("exit", 0)
  uninstall()
  expect(stream.written).toEqual([clearProgressOsc()])
})

test("the exit hook also runs the caller's extra teardown, at most once", () => {
  // run.ts hangs its background-task reap here: this hook, not the turn's
  // `finally`, covers Ctrl+C mid-turn, SIGTERM and hard crashes.
  const stream = fakeStream(true)
  let extra = 0
  const uninstall = installProgressExitClear(stream, () => {
    extra += 1
  })
  process.emit("exit", 0)
  process.emit("exit", 0)
  uninstall()
  expect(extra).toBe(1)
  expect(stream.written).toEqual([clearProgressOsc()])
})

test("a throwing extra teardown never masks the real exit", () => {
  const stream = fakeStream(true)
  const uninstall = installProgressExitClear(stream, () => {
    throw new Error("reap blew up")
  })
  expect(() => process.emit("exit", 0)).not.toThrow()
  uninstall()
})

/**
 * Proves the hook fires on real teardown: a child bun process installs it
 * against an injected TTY-shaped stream and exits. Injecting the stream avoids
 * needing a PTY while still exercising the genuine `process.on("exit")` path.
 */
test("the exit hook fires on a real process exit", async () => {
  const moduleUrl = pathToFileURL(
    fileURLToPath(new URL("../src/attention-headless.ts", import.meta.url)),
  ).href
  const child = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      `const { installProgressExitClear } = await import(${JSON.stringify(moduleUrl)})
       installProgressExitClear({
         isTTY: true,
         write: (chunk) => { process.stdout.write(JSON.stringify(chunk)); return true },
       })
       process.exit(7)`,
    ],
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(child.exitCode).toBe(7)
  expect(child.stdout.toString()).toBe(JSON.stringify(clearProgressOsc()))
}, 20_000)
