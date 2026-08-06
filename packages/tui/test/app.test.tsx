import { expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  loadConfig,
  now,
  runCommand,
  SessionJournal,
  saveHandoff,
  WorkQueue,
} from "@butterfly/core"
import type { CapturedFrame } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { App, clearTerminalProgress, timelineToMessages } from "../src/app"
import { NEWLINE_MARKER } from "../src/paste"
import { installWin32ConsoleGuard } from "../src/terminal-win32"
import { builtinTheme, DARK_TOKENS, LIGHT_TOKENS, themeTokens } from "../src/theme"

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

async function gitFixture(cwd: string): Promise<void> {
  await runCommand("git init -q && git config user.email t@t && git config user.name t", { cwd })
  writeFileSync(join(cwd, "app.ts"), "export const v = 1\n")
  await runCommand("git add -A && git commit -qm init", { cwd })
}

async function stagedGitFixture(cwd: string): Promise<void> {
  await gitFixture(cwd)
  writeFileSync(join(cwd, "app.ts"), "export const v = 2\n")
  await runCommand("git add -A", { cwd })
}

function startFakeChatServer(
  replyText: string,
  opts: { delayMs?: number } = {},
): { baseURL: string; stop: () => void } {
  const body =
    `data: ${JSON.stringify({
      id: "1",
      choices: [
        { index: 0, delta: { role: "assistant", content: replyText }, finish_reason: null },
      ],
    })}\n\n` +
    `data: ${JSON.stringify({
      id: "1",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    })}\n\n` +
    "data: [DONE]\n\n"
  const server = Bun.serve({
    port: 0,
    fetch: async () => {
      if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs))
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    },
  })
  return { baseURL: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) }
}

function startFakeToolCallServer(command: string): { baseURL: string; stop: () => void } {
  const body =
    `data: ${JSON.stringify({
      id: "1",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "bash", arguments: JSON.stringify({ command }) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })}\n\n` +
    `data: ${JSON.stringify({
      id: "1",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    })}\n\n` +
    "data: [DONE]\n\n"
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
  })
  return { baseURL: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) }
}

function startFakeOpenAIModelsServer(ids: string[]): { baseURL: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url)
      if (url.pathname === "/models") return Response.json({ data: ids.map((id) => ({ id })) })
      return new Response("not found", { status: 404 })
    },
  })
  return { baseURL: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

/** Same idea for the keyless "ollama" provider — fetchOllamaModels hits `${baseURL}/api/tags`. */
function startFakeOllamaServer(names: string[]): { baseURL: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url)
      if (url.pathname === "/api/tags") {
        return Response.json({ models: names.map((name) => ({ name })) })
      }
      return new Response("not found", { status: 404 })
    },
  })
  return { baseURL: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

async function waitForFrameSlow(
  t: { renderOnce: () => Promise<void>; captureCharFrame: () => string },
  predicate: (frame: string) => boolean,
  maxWaitMs = 15_000,
): Promise<string> {
  const start = Date.now()
  for (;;) {
    await t.renderOnce()
    const frame = t.captureCharFrame()
    if (predicate(frame)) return frame
    if (Date.now() - start >= maxWaitMs) {
      throw new Error(`Timed out waiting for frame predicate.\nlastFrame:\n${frame}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

test("configured session renders the wordmark on a wide terminal", async () => {
  const t = await testRender(
    () => (
      <App
        cwd={tempDir("bfly-tui-")}
        config={{ model: "mock/model" }}
        home={tempDir("bfly-home-")}
      />
    ),
    { width: 120, height: 30 },
  )
  await t.renderOnce()
  const frame = t.captureCharFrame()
  expect(frame).toContain("██")
  expect(frame).toContain("mock/model")
  t.renderer.destroy()
})

test("narrow terminals fall back to the plain header, no pixel mark", async () => {
  const t = await testRender(
    () => (
      <App
        cwd={tempDir("bfly-tui-")}
        config={{ model: "mock/model" }}
        home={tempDir("bfly-home-")}
      />
    ),
    { width: 60, height: 20 },
  )
  await t.renderOnce()
  const frame = t.captureCharFrame()
  expect(frame).toContain("butterfly")
  expect(frame).not.toContain("██")
  t.renderer.destroy()
})

test("without a model the setup flow opens and lists providers", async () => {
  const t = await testRender(
    () => <App cwd={tempDir("bfly-tui-")} config={{}} home={tempDir("bfly-home-")} />,
    { width: 100, height: 30 },
  )
  await t.renderOnce()
  const frame = t.captureCharFrame()
  expect(frame).toContain("setup")
  expect(frame).toContain("openai")
  expect(frame).toContain("ollama")
  t.renderer.destroy()
})

test("full setup path saves model and key to the global config", async () => {
  const home = tempDir("bfly-home-")
  const t = await testRender(() => <App cwd={tempDir("bfly-tui-")} config={{}} home={home} />, {
    width: 100,
    height: 30,
  })
  await t.renderOnce()

  t.mockInput.typeText("1")
  t.mockInput.pressEnter()
  await t.waitForFrame((frame: string) => frame.includes("API key"))

  t.mockInput.typeText("sk-test-123")
  t.mockInput.pressEnter()
  await t.waitForFrame((frame: string) => frame.includes("Model id"))

  t.mockInput.typeText("gpt-5-mini")
  t.mockInput.pressEnter()
  await t.waitForFrame((frame: string) => frame.includes("Ready on openai/gpt-5-mini"))

  const saved = readFileSync(join(home, ".config", "butterfly", "butterfly.jsonc"), "utf8")
  expect(saved).toContain('"model": "openai/gpt-5-mini"')
  expect(saved).toContain('"apiKey": "sk-test-123"')
  t.renderer.destroy()
}, 30_000)

test("keyless providers skip the key stage", async () => {
  const home = tempDir("bfly-home-")
  const t = await testRender(() => <App cwd={tempDir("bfly-tui-")} config={{}} home={home} />, {
    width: 100,
    height: 30,
  })
  await t.renderOnce()

  t.mockInput.typeText("ollama")
  t.mockInput.pressEnter()
  await t.waitForFrame((frame: string) => frame.includes("Model id"))

  t.mockInput.typeText("qwen3:8b")
  t.mockInput.pressEnter()
  await t.waitForFrame((frame: string) => frame.includes("Ready on ollama/qwen3:8b"))

  const saved = readFileSync(join(home, ".config", "butterfly", "butterfly.jsonc"), "utf8")
  expect(saved).toContain('"model": "ollama/qwen3:8b"')
  expect(saved).not.toContain("apiKey")
  t.renderer.destroy()
}, 30_000)

test("/help lists commands in a configured session", async () => {
  const t = await testRender(
    () => (
      <App
        cwd={tempDir("bfly-tui-")}
        config={{ model: "mock/model" }}
        home={tempDir("bfly-home-")}
      />
    ),
    { width: 100, height: 48 },
  )
  await t.renderOnce()
  t.mockInput.typeText("/help")
  t.mockInput.pressEnter()
  await waitForFrameSlow(t, (frame: string) => frame.includes("/setup"))
  expect(t.captureCharFrame()).toContain("/quit")
  t.renderer.destroy()
})

test("/sessions lists past sessions with the current one marked", async () => {
  const cwd = tempDir("bfly-tui-")
  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
    { width: 100, height: 30 },
  )
  await t.renderOnce()
  t.mockInput.typeText("/sessions")
  t.mockInput.pressEnter()
  await t.waitForFrame((frame: string) => frame.includes("sessions (newest first)"))
  expect(t.captureCharFrame()).toContain("(current)")
  t.renderer.destroy()
})

test("/hooks lists configured hooks with source and enabled state", async () => {
  const cwd = tempDir("bfly-tui-")
  const hooks = [
    { event: "post.tool" as const, match: "edit", command: "npm run lint" },
    { event: "pre.tool" as const, match: "bash", command: "check-policy", enabled: false },
  ]
  writeFileSync(join(cwd, "butterfly.jsonc"), JSON.stringify({ hooks }))
  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model", hooks }} home={tempDir("bfly-home-")} />,
    { width: 100, height: 30 },
  )
  await t.renderOnce()
  t.mockInput.typeText("/hooks")
  t.mockInput.pressEnter()
  await t.waitForFrame((frame: string) => frame.includes("npm run lint"))
  const frame = t.captureCharFrame()
  expect(frame).toContain("check-policy")
  expect(frame).toContain("not run this session")
  t.renderer.destroy()
})

test("/hooks <n> toggles enable/disable and persists it to the fixture config", async () => {
  const cwd = tempDir("bfly-tui-")
  const configPath = join(cwd, "butterfly.jsonc")
  const hooks = [{ event: "post.tool" as const, match: "edit", command: "npm run lint" }]
  writeFileSync(configPath, JSON.stringify({ hooks }))
  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model", hooks }} home={tempDir("bfly-home-")} />,
    { width: 100, height: 30 },
  )
  await t.renderOnce()
  t.mockInput.typeText("/hooks 1")
  t.mockInput.pressEnter()
  await t.waitForFrame((frame: string) => frame.includes("disabled"))

  const saved = JSON.parse(readFileSync(configPath, "utf8"))
  expect(saved.hooks[0].enabled).toBe(false)

  // Toggling again re-enables it — the /hooks listing reflects the flip.
  t.mockInput.typeText("/hooks 1")
  t.mockInput.pressEnter()
  await t.waitForFrame((frame: string) => frame.includes("enabled"))
  const savedAgain = JSON.parse(readFileSync(configPath, "utf8"))
  expect(savedAgain.hooks[0].enabled).toBe(true)
  t.renderer.destroy()
})

test("/hooks <n> fails soft on a commented config file — shows a snippet, never corrupts it", async () => {
  const cwd = tempDir("bfly-tui-")
  const configPath = join(cwd, "butterfly.jsonc")
  const original = `{
  // lint after every edit
  "hooks": [{ "event": "post.tool", "match": "edit", "command": "npm run lint" }]
}`
  writeFileSync(configPath, original)
  const hooks = [{ event: "post.tool" as const, match: "edit", command: "npm run lint" }]
  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model", hooks }} home={tempDir("bfly-home-")} />,
    { width: 100, height: 30 },
  )
  await t.renderOnce()
  t.mockInput.typeText("/hooks 1")
  t.mockInput.pressEnter()
  // "edit it by hand" itself can line-wrap at this terminal width — match a
  // substring guaranteed to stay on one line instead.
  await t.waitForFrame((frame: string) => frame.includes("has comments"))
  expect(t.captureCharFrame()).toContain("npm run lint")
  expect(readFileSync(configPath, "utf8")).toBe(original)
  t.renderer.destroy()
})

test("/doctor prints a context audit with prefix, journal, and config lint sections", async () => {
  const t = await testRender(
    () => (
      <App
        cwd={tempDir("bfly-tui-")}
        config={{ model: "mock/model" }}
        home={tempDir("bfly-home-")}
      />
    ),
    { width: 100, height: 30 },
  )
  await t.renderOnce()
  t.mockInput.typeText("/doctor")
  t.mockInput.pressEnter()
  await t.waitForFrame((frame: string) => frame.includes("prefix breakdown"))
  const frame = t.captureCharFrame()
  expect(frame).toContain("journal:")
  expect(frame).toContain("config lint")
  t.renderer.destroy()
})

test("/review in a clean git repo reports nothing to review, no model call needed", async () => {
  const cwd = tempDir("bfly-tui-")
  await gitFixture(cwd)
  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
    { width: 100, height: 30 },
  )
  await t.renderOnce()
  t.mockInput.typeText("/review")
  t.mockInput.pressEnter()
  await waitForFrameSlow(t, (frame) => frame.includes("nothing to review"))
  t.renderer.destroy()
}, 30_000)

test("/review with a bad revision range reports the git failure, not 'nothing to review'", async () => {
  const cwd = tempDir("bfly-tui-")
  await gitFixture(cwd)
  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
    { width: 100, height: 30 },
  )
  await t.renderOnce()
  t.mockInput.typeText("/review HEAD~999")
  t.mockInput.pressEnter()
  const frame = await waitForFrameSlow(t, (f) => f.includes("git failed"))
  expect(frame).not.toContain("nothing to review")
  const journals = readdirSync(join(cwd, ".butterfly", "sessions"))
  const events = journals.flatMap(
    (file) => SessionJournal.replay(join(cwd, ".butterfly", "sessions", file)).events,
  )
  expect(events.some((e) => e.type === "session.review")).toBe(false)
  t.renderer.destroy()
}, 30_000)

test("a journaled review is rebuilt as a transcript card on replay", () => {
  const restored = timelineToMessages([
    {
      time: now(),
      type: "session.review",
      summary: "MINOR ISSUES: app.ts:1 magic number",
      scope: "unstaged + staged changes",
      diffChars: 1_234,
      truncated: false,
      journalPath: "/tmp/sub.jsonl",
    },
  ])
  expect(restored.length).toBe(1)
  expect(restored[0]?.kind).toBe("tool")
  expect(restored[0]?.text).toContain("review")
  expect(restored[0]?.text).toContain("MINOR ISSUES: app.ts:1 magic number")
  expect(restored[0]?.text).toContain("1,234")
})

test("/commit in a clean git repo offers to stage; declining cancels the commit", async () => {
  const cwd = tempDir("bfly-tui-")
  await gitFixture(cwd)
  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
    { width: 100, height: 30 },
  )
  await t.renderOnce()
  t.mockInput.typeText("/commit")
  t.mockInput.pressEnter()
  await waitForFrameSlow(t, (frame) => frame.includes("stage all tracked modifications"))
  t.mockInput.pressKey("n")
  await waitForFrameSlow(t, (frame) => frame.includes("commit cancelled"))
  t.renderer.destroy()
}, 30_000)

test("/commit in a clean git repo offers to stage; approving finds nothing left to stage", async () => {
  const cwd = tempDir("bfly-tui-")
  await gitFixture(cwd)
  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
    { width: 100, height: 30 },
  )
  await t.renderOnce()
  t.mockInput.typeText("/commit")
  t.mockInput.pressEnter()
  await waitForFrameSlow(t, (frame) => frame.includes("stage all tracked modifications"))
  t.mockInput.pressKey("y")
  await waitForFrameSlow(t, (frame) => frame.includes("still nothing staged"))
  t.renderer.destroy()
}, 30_000)


test("a plain confirmation (no tool/target) never offers [a]lways", async () => {
  const cwd = tempDir("bfly-tui-")
  await gitFixture(cwd)
  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
    { width: 100, height: 30 },
  )
  await t.renderOnce()
  t.mockInput.typeText("/commit")
  t.mockInput.pressEnter()
  const frame = await waitForFrameSlow(t, (frame) =>
    frame.includes("stage all tracked modifications"),
  )
  expect(frame).not.toContain("[a]lways")
  t.mockInput.pressKey("n")
  await waitForFrameSlow(t, (frame) => frame.includes("commit cancelled"))
  t.renderer.destroy()
}, 30_000)

test("a real permission ask (reached via a REAL staged diff + provider round-trip, not a simulation) shows [a]lways with the exact narrowed rule preview", async () => {
  const cwd = tempDir("bfly-tui-")
  await stagedGitFixture(cwd)
  const server = startFakeChatServer("chore: quick-add test commit")
  const t = await testRender(
    () => (
      <App
        cwd={cwd}
        config={{ model: "fake/mock-commit", providers: { fake: { baseURL: server.baseURL } } }}
        home={tempDir("bfly-home-")}
      />
    ),
    { width: 240, height: 30 },
  )
  await t.renderOnce()
  t.mockInput.typeText("/commit")
  t.mockInput.pressEnter()
  const frame = await waitForFrameSlow(t, (f) => f.includes("[a]lways"), 25_000)
  expect(frame).toContain("approve?")
  expect(frame).toContain("bash")
  expect(frame).toContain('[a]lways bash: "git *"')
  t.mockInput.pressKey("a")
  await waitForFrameSlow(t, (f) => f.includes("saved to"), 15_000)
  const written = JSON.parse(readFileSync(join(cwd, "butterfly.jsonc"), "utf8"))
  expect(written.permissions.bash).toEqual({ "git *": "allow" })
  t.renderer.destroy()
  server.stop()
}, 40_000)

test("attention: approval notify does not fire while the terminal is focused (default)", async () => {
  const cwd = tempDir("bfly-tui-")
  await gitFixture(cwd)
  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
    { width: 100, height: 30 },
  )
  await t.renderOnce()

  const notifyCalls: Array<{ message: string; title?: string }> = []
  t.renderer.triggerNotification = ((message: string, title?: string) => {
    notifyCalls.push({ message, title })
    return true
  }) as typeof t.renderer.triggerNotification

  // Still focused (the app's default at launch) — no notify on approval.
  t.mockInput.typeText("/commit")
  t.mockInput.pressEnter()
  await waitForFrameSlow(t, (frame) => frame.includes("stage all tracked modifications"))
  expect(notifyCalls).toEqual([])
  t.mockInput.pressKey("n")
  await waitForFrameSlow(t, (frame) => frame.includes("commit cancelled"))
  t.renderer.destroy()
}, 30_000)

test("attention: approval notify fires once the terminal is blurred", async () => {
  const cwd = tempDir("bfly-tui-")
  await gitFixture(cwd)
  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
    { width: 100, height: 30 },
  )
  await t.renderOnce()

  const notifyCalls: Array<{ message: string; title?: string }> = []
  t.renderer.triggerNotification = ((message: string, title?: string) => {
    notifyCalls.push({ message, title })
    return true
  }) as typeof t.renderer.triggerNotification

  // Blur the terminal window (OpenTUI's onBlur) before the approval fires.
  t.renderer.emit("blur")
  t.mockInput.typeText("/commit")
  t.mockInput.pressEnter()
  await waitForFrameSlow(t, (frame) => frame.includes("stage all tracked modifications"))
  expect(notifyCalls).toEqual([
    {
      message: "approval needed: nothing staged — stage all tracked modifications?",
      title: "butterfly code",
    },
  ])
  t.mockInput.pressKey("n")
  await waitForFrameSlow(t, (frame) => frame.includes("commit cancelled"))
  t.renderer.destroy()
}, 30_000)

test("attention: config notifications:false suppresses the notify even while blurred", async () => {
  const cwd = tempDir("bfly-tui-")
  await gitFixture(cwd)
  const t = await testRender(
    () => (
      <App
        cwd={cwd}
        config={{ model: "mock/model", notifications: false }}
        home={tempDir("bfly-home-")}
      />
    ),
    { width: 100, height: 30 },
  )
  await t.renderOnce()

  const notifyCalls: unknown[] = []
  t.renderer.triggerNotification = ((message: string, title?: string) => {
    notifyCalls.push({ message, title })
    return true
  }) as typeof t.renderer.triggerNotification

  t.renderer.emit("blur")
  t.mockInput.typeText("/commit")
  t.mockInput.pressEnter()
  await waitForFrameSlow(t, (frame) => frame.includes("stage all tracked modifications"))
  expect(notifyCalls).toEqual([])
  t.mockInput.pressKey("n")
  await waitForFrameSlow(t, (frame) => frame.includes("commit cancelled"))
  t.renderer.destroy()
}, 30_000)

test("attention: progress escapes go through the renderer's output path, not a raw stdout write", async () => {
  const t = await testRender(
    () => (
      <App
        cwd={tempDir("bfly-tui-")}
        config={{ model: "mock/model" }}
        home={tempDir("bfly-home-")}
      />
    ),
    { width: 100, height: 30 },
  )
  await t.renderOnce()

  const routed: string[] = []
  const renderer = t.renderer as unknown as { writeOut: (chunk: string) => boolean }
  renderer.writeOut = (chunk: string) => {
    routed.push(chunk)
    return true
  }
  const rawStdout: string[] = []
  const realWrite = process.stdout.write
  process.stdout.write = ((chunk: unknown) => {
    rawStdout.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  try {
    t.mockInput.typeText("hello")
    t.mockInput.pressEnter()
    await t.renderOnce()
  } finally {
    process.stdout.write = realWrite
  }

  // turn.start's indeterminate progress went through the renderer…
  expect(routed).toContain("\x1b]9;4;3;0\x07")
  // …and never straight at process.stdout, where it could interleave with a
  // native frame flush (and pollute test output).
  expect(rawStdout.join("")).not.toContain("\x1b]9;4")
  t.renderer.destroy()
}, 30_000)

test("typing / opens a vertical command list", async () => {
  const t = await testRender(
    () => (
      <App
        cwd={tempDir("bfly-tui-")}
        config={{ model: "mock/model" }}
        home={tempDir("bfly-home-")}
      />
    ),
    { width: 100, height: 32 },
  )
  await t.renderOnce()
  t.mockInput.typeText("/")
  await t.waitForFrame((frame: string) => frame.includes("↑↓ select"))
  const frame = t.captureCharFrame()
  expect(frame).toContain("/help")
  expect(frame).toContain("/setup")
  expect(frame).toContain("list commands")
  t.renderer.destroy()
})

test("arrow keys move the selection and Tab completes the command", async () => {
  const t = await testRender(
    () => (
      <App
        cwd={tempDir("bfly-tui-")}
        config={{ model: "mock/model" }}
        home={tempDir("bfly-home-")}
      />
    ),
    { width: 100, height: 32 },
  )
  await t.renderOnce()
  t.mockInput.typeText("/")
  await t.waitForFrame((frame: string) => frame.includes("↑↓ select"))
  await t.mockInput.pressArrow("down")
  await t.mockInput.pressArrow("down")
  await t.mockInput.pressTab()
  await t.waitForFrame((frame: string) => frame.includes("/model "))
  expect(t.captureCharFrame()).toContain("/model")
  t.renderer.destroy()
})

test("Enter on a bare / runs the selected command, not the raw slash", async () => {
  const t = await testRender(
    () => (
      <App
        cwd={tempDir("bfly-tui-")}
        config={{ model: "mock/model" }}
        home={tempDir("bfly-home-")}
      />
    ),
    { width: 100, height: 45 },
  )
  await t.renderOnce()
  t.mockInput.typeText("/")
  await t.waitForFrame((frame: string) => frame.includes("↑↓ select"))
  t.mockInput.pressEnter()
  await waitForFrameSlow(t, (frame: string) => frame.includes("commands:"))
  expect(t.captureCharFrame()).not.toContain("did you mean")
  t.renderer.destroy()
})

test("/plan toggles read-only mode with a header badge", async () => {
  const t = await testRender(
    () => (
      <App
        cwd={tempDir("bfly-tui-")}
        config={{ model: "mock/model" }}
        home={tempDir("bfly-home-")}
      />
    ),
    { width: 100, height: 32 },
  )
  await t.renderOnce()
  t.mockInput.typeText("/plan")
  t.mockInput.pressEnter()
  await t.waitForFrame((frame: string) => frame.includes("PLAN (read-only)"))
  expect(t.captureCharFrame()).toContain("again to exit")
  t.renderer.destroy()
})

test("theme_mode event flips the reactive token store when no theme is pinned", async () => {
  const t = await testRender(
    () => (
      <App
        cwd={tempDir("bfly-tui-")}
        config={{ model: "mock/model" }}
        home={tempDir("bfly-home-")}
      />
    ),
    { width: 100, height: 30 },
  )
  await t.renderOnce()
  expect(themeTokens()).toEqual(DARK_TOKENS)
  t.renderer.emit("theme_mode", "light")
  await t.renderOnce()
  expect(themeTokens()).toEqual(LIGHT_TOKENS)
  t.renderer.destroy()
})

test("a pinned config.theme is never overridden by an auto theme_mode event", async () => {
  const t = await testRender(
    () => (
      <App
        cwd={tempDir("bfly-tui-")}
        config={{ model: "mock/model", theme: "dark-ansi" }}
        home={tempDir("bfly-home-")}
      />
    ),
    { width: 100, height: 30 },
  )
  await t.renderOnce()
  expect(themeTokens()).toEqual(builtinTheme("dark-ansi"))
  t.renderer.emit("theme_mode", "light")
  await t.renderOnce()
  expect(themeTokens()).toEqual(builtinTheme("dark-ansi"))
  t.renderer.destroy()
})

test("/theme <name> switches the store and persists via saveGlobalConfig", async () => {
  const home = tempDir("bfly-home-")
  const t = await testRender(
    () => <App cwd={tempDir("bfly-tui-")} config={{ model: "mock/model" }} home={home} />,
    { width: 100, height: 30 },
  )
  await t.renderOnce()
  t.mockInput.typeText("/theme light")
  t.mockInput.pressEnter()
  await waitForFrameSlow(t, (frame) => frame.includes("theme set to light"))
  expect(themeTokens()).toEqual(LIGHT_TOKENS)
  const reloaded = loadConfig({ cwd: tempDir("bfly-tui-reload-"), home })
  expect(reloaded.theme).toBe("light")
  t.renderer.destroy()
})

test("/theme with no arg opens a picker listing the built-in theme names", async () => {
  const t = await testRender(
    () => (
      <App
        cwd={tempDir("bfly-tui-")}
        config={{ model: "mock/model" }}
        home={tempDir("bfly-home-")}
      />
    ),
    { width: 100, height: 30 },
  )
  await t.renderOnce()
  t.mockInput.typeText("/theme")
  t.mockInput.pressEnter()
  await waitForFrameSlow(t, (frame) => frame.includes("theme —"))
  const frame = t.captureCharFrame()
  expect(frame).toContain("dark")
  expect(frame).toContain("light")
  expect(frame).toContain("dark-ansi")
  t.renderer.destroy()
})

test("/theme with an unknown name errors instead of silently switching to dark", async () => {
  const t = await testRender(
    () => (
      <App
        cwd={tempDir("bfly-tui-")}
        config={{ model: "mock/model" }}
        home={tempDir("bfly-home-")}
      />
    ),
    { width: 100, height: 30 },
  )
  await t.renderOnce()
  t.mockInput.typeText("/theme bogus")
  t.mockInput.pressEnter()
  await waitForFrameSlow(t, (frame) => frame.includes("unknown theme"))
  expect(themeTokens()).toEqual(DARK_TOKENS)
  t.renderer.destroy()
})

test("/provider opens a picker showing (current) and ✓ key markers", async () => {
  const t = await testRender(
    () => (
      <App
        cwd={tempDir("bfly-tui-")}
        config={{
          model: "anthropic/claude-x",
          providers: { anthropic: { apiKey: "sk-a" } },
        }}
        home={tempDir("bfly-home-")}
      />
    ),
    { width: 100, height: 30 },
  )
  await t.renderOnce()
  t.mockInput.typeText("/provider")
  t.mockInput.pressEnter()
  const frame = await waitForFrameSlow(t, (f) => f.includes("provider —"))
  expect(frame).toContain("anthropic  (current)")
  expect(frame).toContain("✓ key")
  expect(frame).toContain("openai")
  t.renderer.destroy()
})

test("/provider <prefix> resolves a unique prefix and skips the picker", async () => {
  const t = await testRender(
    () => (
      <App
        cwd={tempDir("bfly-tui-")}
        config={{ model: "openai/gpt-4" }}
        home={tempDir("bfly-home-")}
      />
    ),
    { width: 100, height: 30 },
  )
  await t.renderOnce()
  t.mockInput.typeText("/provider anthro")
  t.mockInput.pressEnter()
  const frame = await waitForFrameSlow(t, (f) => f.includes("anthropic API key"))
  expect(frame).not.toContain("provider —")
  t.renderer.destroy()
})

test("/provider <unknown> errors and lists valid provider names", async () => {
  const t = await testRender(
    () => (
      <App
        cwd={tempDir("bfly-tui-")}
        config={{ model: "mock/model" }}
        home={tempDir("bfly-home-")}
      />
    ),
    { width: 100, height: 30 },
  )
  await t.renderOnce()
  t.mockInput.typeText("/provider bogus")
  t.mockInput.pressEnter()
  const frame = await waitForFrameSlow(t, (f) => f.includes("unknown provider"))
  expect(frame).toContain("bogus")
  expect(frame).toContain("openrouter")
  t.renderer.destroy()
})

test("/provider ollama (keyless) skips the key step and opens a live model picker", async () => {
  const home = tempDir("bfly-home-")
  const server = startFakeOllamaServer(["llama3:8b", "qwen3:8b"])
  try {
    const t = await testRender(
      () => (
        <App
          cwd={tempDir("bfly-tui-")}
          config={{
            model: "openai/gpt-4",
            providers: { ollama: { baseURL: server.baseURL } },
          }}
          home={home}
        />
      ),
      { width: 100, height: 30 },
    )
    await t.renderOnce()
    t.mockInput.typeText("/provider ollama")
    t.mockInput.pressEnter()
    const frame = await waitForFrameSlow(t, (f) => f.includes("ollama models"))
    expect(frame).not.toContain("API key")
    expect(frame).toContain("llama3:8b")
    expect(frame).toContain("qwen3:8b")
    t.renderer.destroy()
  } finally {
    server.stop()
  }
}, 20_000)

test("Esc at the ollama model picker cancels — nothing is written", async () => {
  const home = tempDir("bfly-home-")
  const server = startFakeOllamaServer(["llama3:8b"])
  try {
    const t = await testRender(
      () => (
        <App
          cwd={tempDir("bfly-tui-")}
          config={{
            model: "anthropic/claude-x",
            providers: { ollama: { baseURL: server.baseURL } },
          }}
          home={home}
        />
      ),
      { width: 100, height: 30 },
    )
    await t.renderOnce()
    t.mockInput.typeText("/provider ollama")
    t.mockInput.pressEnter()
    await waitForFrameSlow(t, (f) => f.includes("llama3:8b"))
    t.mockInput.pressEscape()
    await waitForFrameSlow(t, (f) => !f.includes("llama3:8b"))
    expect(existsSync(join(home, ".config", "butterfly", "butterfly.jsonc"))).toBe(false)
    t.renderer.destroy()
  } finally {
    server.stop()
  }
}, 20_000)

test("Esc at the key step cancels the whole flow — no key typed, no config written", async () => {
  const home = tempDir("bfly-home-")
  const t = await testRender(
    () => (
      <App cwd={tempDir("bfly-tui-")} config={{ model: "anthropic/claude-x" }} home={home} />
    ),
    { width: 100, height: 30 },
  )
  await t.renderOnce()
  t.mockInput.typeText("/provider openai")
  t.mockInput.pressEnter()
  const keyFrame = await waitForFrameSlow(t, (f) => f.includes("openai API key"))
  expect(keyFrame).toContain("paste your API key")
  t.mockInput.typeText("sk-typed-but-abandoned")
  t.mockInput.pressEscape()
  await waitForFrameSlow(t, (f) => f.includes("provider switch cancelled"))
  expect(t.captureCharFrame()).not.toContain("sk-typed-but-abandoned")
  expect(existsSync(join(home, ".config", "butterfly", "butterfly.jsonc"))).toBe(false)
  t.renderer.destroy()
})

test("key step: Enter with an existing key keeps it — does not overwrite or blank it", async () => {
  const home = tempDir("bfly-home-")
  const cfgDir = join(home, ".config", "butterfly")
  mkdirSync(cfgDir, { recursive: true })
  writeFileSync(
    join(cfgDir, "butterfly.jsonc"),
    JSON.stringify({
      model: "anthropic/claude-x",
      providers: { openai: { apiKey: "sk-openai-original" } },
    }),
  )
  const server = startFakeOpenAIModelsServer(["gpt-eval-1"])
  try {
    const t = await testRender(
      () => (
        <App
          cwd={tempDir("bfly-tui-")}
          config={{
            model: "anthropic/claude-x",
            providers: { openai: { apiKey: "sk-openai-original", baseURL: server.baseURL } },
          }}
          home={home}
        />
      ),
      { width: 100, height: 30 },
    )
    await t.renderOnce()
    t.mockInput.typeText("/provider openai")
    t.mockInput.pressEnter()
    const keyFrame = await waitForFrameSlow(t, (f) => f.includes("openai API key"))
    expect(keyFrame).toContain("Enter keeps the saved key")
    t.mockInput.pressEnter() // blank — keep existing
    await waitForFrameSlow(t, (f) => f.includes("gpt-eval-1"))
    t.mockInput.pressEnter() // pick the only model
    await waitForFrameSlow(t, (f) => f.includes("Ready on openai/gpt-eval-1"))

    const saved = JSON.parse(readFileSync(join(cfgDir, "butterfly.jsonc"), "utf8"))
    expect(saved.providers.openai.apiKey).toBe("sk-openai-original")
    t.renderer.destroy()
  } finally {
    server.stop()
  }
}, 20_000)

test("key step: typing a new value replaces the saved key", async () => {
  const home = tempDir("bfly-home-")
  const cfgDir = join(home, ".config", "butterfly")
  mkdirSync(cfgDir, { recursive: true })
  writeFileSync(
    join(cfgDir, "butterfly.jsonc"),
    JSON.stringify({
      model: "anthropic/claude-x",
      providers: { openai: { apiKey: "sk-openai-original" } },
    }),
  )
  const server = startFakeOpenAIModelsServer(["gpt-eval-1"])
  try {
    const t = await testRender(
      () => (
        <App
          cwd={tempDir("bfly-tui-")}
          config={{
            model: "anthropic/claude-x",
            providers: { openai: { apiKey: "sk-openai-original", baseURL: server.baseURL } },
          }}
          home={home}
        />
      ),
      { width: 100, height: 30 },
    )
    await t.renderOnce()
    t.mockInput.typeText("/provider openai")
    t.mockInput.pressEnter()
    await waitForFrameSlow(t, (f) => f.includes("openai API key"))
    t.mockInput.typeText("sk-openai-replaced")
    t.mockInput.pressEnter()
    await waitForFrameSlow(t, (f) => f.includes("gpt-eval-1"))
    t.mockInput.pressEnter()
    await waitForFrameSlow(t, (f) => f.includes("Ready on openai/gpt-eval-1"))

    const saved = JSON.parse(readFileSync(join(cfgDir, "butterfly.jsonc"), "utf8"))
    expect(saved.providers.openai.apiKey).toBe("sk-openai-replaced")
    t.renderer.destroy()
  } finally {
    server.stop()
  }
}, 20_000)

test("model pick persists provider+model+key, preserves other providers' keys, and applies live", async () => {
  const home = tempDir("bfly-home-")
  const cfgDir = join(home, ".config", "butterfly")
  mkdirSync(cfgDir, { recursive: true })
  writeFileSync(
    join(cfgDir, "butterfly.jsonc"),
    JSON.stringify({
      model: "anthropic/claude-x",
      providers: { anthropic: { apiKey: "sk-anthropic-keep" } },
    }),
  )
  const server = startFakeOpenAIModelsServer(["gpt-eval-1"])
  try {
    const t = await testRender(
      () => (
        <App
          cwd={tempDir("bfly-tui-")}
          config={{
            model: "anthropic/claude-x",
            providers: {
              anthropic: { apiKey: "sk-anthropic-keep" },
              openai: { baseURL: server.baseURL },
            },
          }}
          home={home}
        />
      ),
      { width: 100, height: 30 },
    )
    await t.renderOnce()
    t.mockInput.typeText("/provider openai")
    t.mockInput.pressEnter()
    await waitForFrameSlow(t, (f) => f.includes("openai API key"))
    t.mockInput.typeText("sk-openai-new")
    t.mockInput.pressEnter()
    await waitForFrameSlow(t, (f) => f.includes("gpt-eval-1"))
    t.mockInput.pressEnter()
    await waitForFrameSlow(t, (f) => f.includes("Ready on openai/gpt-eval-1"))

    // Live apply: header model ref updates without a restart.
    expect(t.captureCharFrame()).toContain("openai/gpt-eval-1")

    const saved = JSON.parse(readFileSync(join(cfgDir, "butterfly.jsonc"), "utf8"))
    expect(saved.model).toBe("openai/gpt-eval-1")
    expect(saved.providers.openai.apiKey).toBe("sk-openai-new")
    expect(saved.providers.anthropic.apiKey).toBe("sk-anthropic-keep")
    t.renderer.destroy()
  } finally {
    server.stop()
  }
}, 20_000)


function startFake401ModelsServer(): { baseURL: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(JSON.stringify({ error: { code: "invalid_api_key" } }), { status: 401 }),
  })
  return { baseURL: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

test("a 401 on the live model list falls back to the catalog WITH a visible not-validated note", async () => {
  const home = tempDir("bfly-home-")
  // Non-empty catalog for openai, so the fallback actually has rows to show
  // (an empty one takes the noModelsNote branch, a different path).
  seedCatalogCache(home, "openai", "gpt-cat-1", { input: 1, output: 2 })
  const server = startFake401ModelsServer()
  try {
    const t = await testRender(
      () => (
        <App
          cwd={tempDir("bfly-tui-")}
          config={{
            model: "anthropic/claude-x",
            providers: { openai: { baseURL: server.baseURL } },
          }}
          home={home}
        />
      ),
      { width: 120, height: 32 },
    )
    await t.renderOnce()
    t.mockInput.typeText("/provider openai")
    t.mockInput.pressEnter()
    await waitForFrameSlow(t, (f) => f.includes("openai API key"))
    t.mockInput.typeText("sk-expired-and-wrong")
    t.mockInput.pressEnter()

    const picked = await waitForFrameSlow(t, (f) => f.includes("gpt-cat-1"))
    expect(picked).toContain("live list unavailable")
    expect(picked).toContain("the key was NOT validated")

    t.mockInput.pressEnter()
    const savedFrame = await waitForFrameSlow(t, (f) => f.includes("Ready on openai/gpt-cat-1"))
    // A note, not a blocker — the save still happens in full.
    const saved = JSON.parse(
      readFileSync(join(home, ".config", "butterfly", "butterfly.jsonc"), "utf8"),
    )
    expect(saved.model).toBe("openai/gpt-cat-1")
    expect(saved.providers.openai.apiKey).toBe("sk-expired-and-wrong")
    // …and the caution outlives the picker that carried it, since the save
    // lines are what the user is left looking at.
    expect(savedFrame).toContain("the key was NOT validated")
    t.renderer.destroy()
  } finally {
    server.stop()
  }
}, 30_000)

test("a live model list carries NO catalog note — the disclosure is not blanket noise", async () => {
  const home = tempDir("bfly-home-")
  const server = startFakeOpenAIModelsServer(["gpt-eval-1"])
  try {
    const t = await testRender(
      () => (
        <App
          cwd={tempDir("bfly-tui-")}
          config={{
            model: "anthropic/claude-x",
            providers: { openai: { baseURL: server.baseURL } },
          }}
          home={home}
        />
      ),
      { width: 120, height: 32 },
    )
    await t.renderOnce()
    t.mockInput.typeText("/provider openai")
    t.mockInput.pressEnter()
    await waitForFrameSlow(t, (f) => f.includes("openai API key"))
    t.mockInput.typeText("sk-good")
    t.mockInput.pressEnter()
    const picked = await waitForFrameSlow(t, (f) => f.includes("gpt-eval-1"))
    expect(picked).not.toContain("live list unavailable")
    t.mockInput.pressEnter()
    const savedFrame = await waitForFrameSlow(t, (f) => f.includes("Ready on openai/gpt-eval-1"))
    expect(savedFrame).not.toContain("NOT validated")
    t.renderer.destroy()
  } finally {
    server.stop()
  }
}, 30_000)

test("a chip-worthy paste at the /provider key step stays raw text and leaves no orphan payload", async () => {
  const t = await testRender(
    () => (
      <App
        cwd={tempDir("bfly-tui-")}
        config={{ model: "mock/model" }}
        home={tempDir("bfly-home-")}
      />
    ),
    { width: 120, height: 34 },
  )
  await t.renderOnce()
  const composer = findComposer(t.renderer.root)
  if (!composer) throw new Error("composer not found")

  t.mockInput.typeText("/provider openai")
  t.mockInput.pressEnter()
  await waitForFrameSlow(t, (f) => f.includes("openai API key"))

  const pasted = `sk-proj-${"A".repeat(900)}`
  await t.mockInput.pasteBracketedText(pasted)
  await t.renderOnce()
  expect(composer.value).toBe(pasted)
  expect(t.captureCharFrame()).not.toContain("[Pasted #")

  t.mockInput.pressEscape()
  await waitForFrameSlow(t, (f) => f.includes("provider switch cancelled"))

  // The abandoned paste must not survive as a payload nobody references.
  t.mockInput.typeText("hello there")
  t.mockInput.pressEnter()
  await waitForFrameSlow(t, (f) => f.includes("hello there"))
  expect(t.captureCharFrame()).not.toContain("no longer in the message")
  t.renderer.destroy()
}, 30_000)

test("typing @ opens the mention picker and selecting inserts an @token", async () => {
  const cwd = tempDir("bfly-tui-")
  writeFileSync(join(cwd, "notes.md"), "hello\n")
  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
    { width: 100, height: 32 },
  )
  await t.renderOnce()
  t.mockInput.typeText("look at @")
  await t.waitForFrame((frame: string) => frame.includes("mention a file"))
  expect(t.captureCharFrame()).toContain("notes.md")
  t.mockInput.pressEnter()
  await t.waitForFrame((frame: string) => frame.includes("@notes.md"))
  expect(t.captureCharFrame()).toContain("look at @notes.md")
  t.renderer.destroy()
}, 30_000)

test("continuing to type after @ filters the mention picker", async () => {
  const cwd = tempDir("bfly-tui-")
  writeFileSync(join(cwd, "alpha.ts"), "export {}\n")
  writeFileSync(join(cwd, "beta.ts"), "export {}\n")
  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
    { width: 100, height: 32 },
  )
  await t.renderOnce()
  t.mockInput.typeText("@")
  await t.waitForFrame((frame: string) => frame.includes("mention a file"))
  t.mockInput.typeText("bet")
  await t.waitForFrame((frame: string) => frame.includes("beta.ts") && !frame.includes("alpha.ts"))
  t.mockInput.pressEnter()
  await t.waitForFrame((frame: string) => frame.includes("@beta.ts"))
  expect(t.captureCharFrame()).toContain("@beta.ts")
  t.renderer.destroy()
}, 30_000)

test("selecting a candidate whose path has a space quotes the inserted @token", async () => {
  const cwd = tempDir("bfly-tui-")
  writeFileSync(join(cwd, "Getting Started.md"), "hello\n")
  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
    { width: 100, height: 32 },
  )
  await t.renderOnce()
  t.mockInput.typeText("@")
  await t.waitForFrame((frame: string) => frame.includes("mention a file"))
  expect(t.captureCharFrame()).toContain("Getting Started.md")
  t.mockInput.pressEnter()
  await t.waitForFrame((frame: string) => frame.includes('@"Getting Started.md"'))
  expect(t.captureCharFrame()).toContain('@"Getting Started.md"')
  t.renderer.destroy()
}, 30_000)

test("typing a path to an existing image attaches it as a chip and clears it from the draft", async () => {
  const cwd = tempDir("bfly-tui-")
  writeFileSync(join(cwd, "shot.png"), Buffer.from("fake-png-bytes"))
  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
    { width: 100, height: 32 },
  )
  await t.renderOnce()
  t.mockInput.typeText("look at shot.png")
  await t.waitForFrame((frame: string) => frame.includes("📎"))
  const frame = t.captureCharFrame()
  expect(frame).toContain("📎 1 image")
  expect(frame).toContain("shot.png")
  const composer = findComposer(t.renderer.root)
  expect(composer?.value.trim()).toBe("look at")
  t.renderer.destroy()
}, 30_000)

test("attaching a second image increments the chip count", async () => {
  const cwd = tempDir("bfly-tui-")
  writeFileSync(join(cwd, "a.png"), Buffer.from("a-bytes"))
  writeFileSync(join(cwd, "b.jpg"), Buffer.from("b-bytes"))
  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
    { width: 100, height: 32 },
  )
  await t.renderOnce()
  t.mockInput.typeText("a.png ")
  await t.waitForFrame((frame: string) => frame.includes("📎 1 image"))
  t.mockInput.typeText("b.jpg")
  await t.waitForFrame((frame: string) => frame.includes("📎 2 images"))
  t.renderer.destroy()
}, 30_000)

test("a path-like token that isn't a real file is left alone — no false-positive chip", async () => {
  const t = await testRender(
    () => (
      <App
        cwd={tempDir("bfly-tui-")}
        config={{ model: "mock/model" }}
        home={tempDir("bfly-home-")}
      />
    ),
    { width: 100, height: 32 },
  )
  await t.renderOnce()
  t.mockInput.typeText("see cat.png for details")
  await t.renderOnce()
  const frame = t.captureCharFrame()
  expect(frame).not.toContain("📎")
  expect(frame).toContain("cat.png")
  t.renderer.destroy()
}, 30_000)

/**
 * The composer `<input>`: the only renderable in the app that owns a
 * `submit()` + `placeholder`. Found by walking the tree rather than by class
 * identity so it survives OpenTUI's bundled class renaming.
 */
interface Composer {
  on: (event: string, callback: () => void) => void
  value: string
  cursorOffset: number
}
function findComposer(node: unknown): Composer | undefined {
  const candidate = node as {
    getChildren?: () => unknown[]
    submit?: unknown
    placeholder?: unknown
  }
  if (typeof candidate?.submit === "function" && "placeholder" in candidate) {
    return candidate as unknown as Composer
  }
  for (const child of candidate?.getChildren?.() ?? []) {
    const found = findComposer(child)
    if (found) return found
  }
  return undefined
}

/** Counts every time the composer's own submit path fires. */
function countSubmits(t: { renderer: { root: unknown } }): {
  composer: Composer
  count: () => number
  reset: () => void
} {
  const composer = findComposer(t.renderer.root)
  if (!composer) throw new Error("composer input not found in the render tree")
  let submits = 0
  composer.on("enter", () => {
    submits += 1
  })
  return { composer, count: () => submits, reset: () => (submits = 0) }
}

test("Enter on the mention picker picks — it must not also submit a turn", async () => {
  const cwd = tempDir("bfly-tui-")
  writeFileSync(join(cwd, "notes.md"), "hello\n")
  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
    { width: 100, height: 32 },
  )
  await t.renderOnce()
  const submits = countSubmits(t)

  t.mockInput.typeText("look at @")
  await t.waitForFrame((frame: string) => frame.includes("mention a file"))
  t.mockInput.pressEnter()
  await t.renderOnce()

  // Exactly one action: the pick landed in the composer…
  expect(t.captureCharFrame()).toContain("look at @notes.md")
  // …and the very same Enter did NOT also reach the composer, whose submit
  // reads the just-updated draft and kicks off a bogus turn.
  expect(submits.count()).toBe(0)
  // A submitted turn echoes the task into the transcript as "❯ <task>".
  expect(t.captureCharFrame()).not.toContain("❯ look at")
  t.renderer.destroy()
}, 30_000)

test("Enter on the effort picker is consumed by the picker alone (same guarantee, other picker)", async () => {
  const t = await testRender(
    () => (
      <App
        cwd={tempDir("bfly-tui-")}
        config={{ model: "mock/model" }}
        home={tempDir("bfly-home-")}
      />
    ),
    { width: 100, height: 32 },
  )
  await t.renderOnce()
  const submits = countSubmits(t)

  t.mockInput.typeText("/think")
  t.mockInput.pressEnter()
  await t.waitForFrame((frame: string) => frame.includes("thinking effort"))
  // That first Enter legitimately submitted "/think". Only the picker's own
  // Enter is under test.
  submits.reset()

  t.mockInput.pressArrow("down")
  t.mockInput.pressEnter()
  await t.waitForFrame((frame: string) => frame.includes("(this session)"))
  expect(submits.count()).toBe(0)
  t.renderer.destroy()
}, 30_000)

test("answering an approval prompt does not type the answer into the composer", async () => {
  const cwd = tempDir("bfly-tui-")
  await gitFixture(cwd)
  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
    { width: 100, height: 30 },
  )
  await t.renderOnce()
  const submits = countSubmits(t)

  t.mockInput.typeText("/commit")
  t.mockInput.pressEnter()
  await waitForFrameSlow(t, (frame) => frame.includes("stage all tracked modifications"))
  submits.reset()
  t.mockInput.pressKey("n")
  await waitForFrameSlow(t, (frame) => frame.includes("commit cancelled"))

  // The prompt is modal: its keys belong to it, not to the composer.
  expect(submits.composer.value).toBe("")
  expect(submits.count()).toBe(0)
  t.renderer.destroy()
}, 30_000)

test("/rewind opens a picker listing turn + per-call checkpoints", async () => {
  const cwd = tempDir("bfly-tui-")
  const sessionsDir = join(cwd, ".butterfly", "sessions")
  const journal = SessionJournal.create(sessionsDir, "fixture0001")
  journal.append({ type: "session.created", cwd, time: now() })
  journal.append({ type: "turn.snapshot", tree: "a".repeat(40), untracked: [], time: now() })
  journal.append({ type: "message.user", id: "u1", text: "edit app.ts", time: now() })
  journal.append({
    type: "turn.snapshot",
    tree: "b".repeat(40),
    callId: "c1",
    tool: "edit",
    argsPreview: '{"file_path":"app.ts"}',
    untracked: [],
    time: now(),
  })
  journal.append({ type: "message.assistant", id: "a1", text: "done", time: now() })
  journal.append({
    type: "turn.completed",
    model: "mock/model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    time: now(),
  })

  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
    { width: 100, height: 32 },
  )
  await t.renderOnce()

  t.mockInput.typeText("/resume fixture0001")
  t.mockInput.pressEnter()
  await t.waitForFrame((frame: string) => frame.includes("resumed session"))

  t.mockInput.typeText("/rewind")
  t.mockInput.pressEnter()
  await t.waitForFrame((frame: string) => frame.includes("rewind to checkpoint"))
  const frame = t.captureCharFrame()
  expect(frame).toContain("edit")
  expect(frame).toContain("app.ts")
  expect(frame).toContain("turn start")
  t.renderer.destroy()
}, 30_000)

test("selecting a checkpoint opens the files/conversation/both restore picker", async () => {
  const cwd = tempDir("bfly-tui-")
  const sessionsDir = join(cwd, ".butterfly", "sessions")
  const journal = SessionJournal.create(sessionsDir, "fixture0002")
  journal.append({ type: "session.created", cwd, time: now() })
  journal.append({ type: "turn.snapshot", tree: "a".repeat(40), untracked: [], time: now() })
  journal.append({ type: "message.user", id: "u1", text: "do a thing", time: now() })
  journal.append({
    type: "turn.completed",
    model: "mock/model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    time: now(),
  })

  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
    { width: 100, height: 32 },
  )
  await t.renderOnce()

  t.mockInput.typeText("/resume fixture0002")
  t.mockInput.pressEnter()
  await t.waitForFrame((frame: string) => frame.includes("resumed session"))

  t.mockInput.typeText("/rewind")
  t.mockInput.pressEnter()
  await t.waitForFrame((frame: string) => frame.includes("rewind to checkpoint"))
  t.mockInput.pressEnter()
  await t.waitForFrame((frame: string) => frame.includes("pick what to revert"))
  const frame = t.captureCharFrame()
  expect(frame).toContain("files only")
  expect(frame).toContain("conversation only")
  expect(frame).toContain("both")
  t.renderer.destroy()
}, 30_000)

test("Ctrl+O opens and closes the transcript pager", async () => {
  const t = await testRender(
    () => (
      <App
        cwd={tempDir("bfly-tui-")}
        config={{ model: "mock/model" }}
        home={tempDir("bfly-home-")}
      />
    ),
    { width: 100, height: 32 },
  )
  await t.renderOnce()
  t.mockInput.pressKey("o", { ctrl: true })
  await t.waitForFrame((frame: string) => frame.includes("PAGER"))
  expect(t.captureCharFrame()).toContain("q/Esc")
  t.mockInput.pressKey("o", { ctrl: true })
  await t.waitForFrame((frame: string) => !frame.includes("PAGER"))
  t.renderer.destroy()
})

test("pager search finds prompt text from a replayed journal fixture, n/N cycle matches", async () => {
  const cwd = tempDir("bfly-tui-")
  const sessionsDir = join(cwd, ".butterfly", "sessions")
  const journal = SessionJournal.create(sessionsDir, "pagerfix0001")
  journal.append({ type: "session.created", cwd, time: now() })
  journal.append({
    type: "message.user",
    id: "u1",
    text: "please locate xyzzyfindme in app.ts",
    time: now(),
  })
  journal.append({ type: "message.assistant", id: "a1", text: "sure, looking now", time: now() })
  journal.append({
    type: "message.user",
    id: "u2",
    text: "also check xyzzyfindme in lib.ts",
    time: now(),
  })
  journal.append({ type: "message.assistant", id: "a2", text: "done", time: now() })

  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
    { width: 100, height: 40 },
  )
  await t.renderOnce()
  t.mockInput.typeText("/resume pagerfix0001")
  t.mockInput.pressEnter()
  await t.waitForFrame((frame: string) => frame.includes("resumed session"))

  t.mockInput.pressKey("o", { ctrl: true })
  await waitForFrameSlow(t, (frame) => frame.includes("PAGER") && frame.includes("xyzzyfindme"))

  t.mockInput.typeText("/")
  t.mockInput.typeText("xyzzyfindme")
  await t.waitForFrame((frame: string) => frame.includes("match 1/2"))

  t.mockInput.pressEnter() // commits the search, hands n/N back their keys
  t.mockInput.pressKey("n")
  await t.waitForFrame((frame: string) => frame.includes("match 2/2"))
  t.mockInput.pressKey("n")
  await t.waitForFrame((frame: string) => frame.includes("match 1/2")) // wraps
  t.mockInput.typeText("N")
  await t.waitForFrame((frame: string) => frame.includes("match 2/2")) // wraps back

  t.renderer.destroy()
}, 30_000)

test("{ and } jump between user prompts in the pager", async () => {
  const cwd = tempDir("bfly-tui-")
  const sessionsDir = join(cwd, ".butterfly", "sessions")
  const journal = SessionJournal.create(sessionsDir, "pagerfix0002")
  journal.append({ type: "session.created", cwd, time: now() })
  journal.append({ type: "message.user", id: "u1", text: "first prompt marker", time: now() })
  journal.append({ type: "message.assistant", id: "a1", text: "ok", time: now() })
  journal.append({ type: "message.user", id: "u2", text: "second prompt marker", time: now() })
  journal.append({ type: "message.assistant", id: "a2", text: "ok2", time: now() })
  journal.append({ type: "message.user", id: "u3", text: "third prompt marker", time: now() })

  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
    { width: 100, height: 40 },
  )
  await t.renderOnce()
  t.mockInput.typeText("/resume pagerfix0002")
  t.mockInput.pressEnter()
  await t.waitForFrame((frame: string) => frame.includes("resumed session"))

  t.mockInput.pressKey("o", { ctrl: true })
  await t.waitForFrame((frame: string) => frame.includes("PAGER"))

  t.mockInput.typeText("}")
  await t.waitForFrame((frame: string) => frame.includes("prompt 1/3"))
  t.mockInput.typeText("}")
  await t.waitForFrame((frame: string) => frame.includes("prompt 2/3"))
  t.mockInput.typeText("{")
  await t.waitForFrame((frame: string) => frame.includes("prompt 1/3"))

  t.renderer.destroy()
}, 30_000)

test("[ dumps the transcript to a file and reports the path in the pager footer", async () => {
  const cwd = tempDir("bfly-tui-")
  const sessionsDir = join(cwd, ".butterfly", "sessions")
  const journal = SessionJournal.create(sessionsDir, "pagerfix0003")
  journal.append({ type: "session.created", cwd, time: now() })
  journal.append({ type: "message.user", id: "u1", text: "dump me please", time: now() })

  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
    { width: 100, height: 40 },
  )
  await t.renderOnce()
  t.mockInput.typeText("/resume pagerfix0003")
  t.mockInput.pressEnter()
  await t.waitForFrame((frame: string) => frame.includes("resumed session"))

  t.mockInput.pressKey("o", { ctrl: true })
  await t.waitForFrame((frame: string) => frame.includes("PAGER"))

  t.mockInput.typeText("[")
  const frame = await waitForFrameSlow(t, (f) => f.includes(".md"))
  expect(frame).toContain("saved")

  t.renderer.destroy()
}, 30_000)

test("v with no $EDITOR/$VISUAL configured falls back to reporting the exported file path", async () => {
  const cwd = tempDir("bfly-tui-")
  const sessionsDir = join(cwd, ".butterfly", "sessions")
  const journal = SessionJournal.create(sessionsDir, "pagerfix0004")
  journal.append({ type: "session.created", cwd, time: now() })
  journal.append({ type: "message.user", id: "u1", text: "export me please", time: now() })

  const savedEditor = process.env.EDITOR
  const savedVisual = process.env.VISUAL
  delete process.env.EDITOR
  delete process.env.VISUAL
  try {
    const t = await testRender(
      () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
      { width: 100, height: 40 },
    )
    await t.renderOnce()
    t.mockInput.typeText("/resume pagerfix0004")
    t.mockInput.pressEnter()
    await t.waitForFrame((frame: string) => frame.includes("resumed session"))

    t.mockInput.pressKey("o", { ctrl: true })
    await t.waitForFrame((frame: string) => frame.includes("PAGER"))

    t.mockInput.typeText("v")
    const frame = await waitForFrameSlow(t, (f) => f.includes(".md"))
    expect(frame).toContain("no $EDITOR")

    t.renderer.destroy()
  } finally {
    if (savedEditor !== undefined) process.env.EDITOR = savedEditor
    if (savedVisual !== undefined) process.env.VISUAL = savedVisual
  }
}, 30_000)

test("Ctrl+O in the pager is consumed by the pager alone — it must not also submit a turn", async () => {
  const t = await testRender(
    () => (
      <App
        cwd={tempDir("bfly-tui-")}
        config={{ model: "mock/model" }}
        home={tempDir("bfly-home-")}
      />
    ),
    { width: 100, height: 32 },
  )
  await t.renderOnce()
  const submits = countSubmits(t)

  t.mockInput.pressKey("o", { ctrl: true })
  await t.waitForFrame((frame: string) => frame.includes("PAGER"))
  t.mockInput.typeText("q")
  await t.waitForFrame((frame: string) => !frame.includes("PAGER"))
  expect(submits.count()).toBe(0)
  expect(submits.composer.value).toBe("")
  t.renderer.destroy()
})

/**
 * An OpenAI-compatible endpoint that accepts the request and never answers.
 * `App` builds its own provider from `config` (there is no injection seam),
 * so a socket that just hangs is the only deterministic way to park the TUI
 * in `busy()` for as long as a test needs. Callers must stop it.
 */
function hangingProvider(): { stop: () => void; baseURL: string } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Promise<Response>(() => {}),
  })
  return { stop: () => server.stop(true), baseURL: `http://127.0.0.1:${server.port}/v1` }
}

test("Ctrl+C interrupts a busy turn from inside the pager", async () => {
  const cwd = tempDir("bfly-tui-")
  await gitFixture(cwd)
  const provider = hangingProvider()
  try {
    const t = await testRender(
      () => (
        <App
          cwd={cwd}
          config={{ model: "hang/model", providers: { hang: { baseURL: provider.baseURL } } }}
          home={tempDir("bfly-home-")}
        />
      ),
      { width: 100, height: 40, exitOnCtrlC: false },
    )
    await t.renderOnce()

    t.mockInput.typeText("hold this turn open")
    t.mockInput.pressEnter()
    await waitForFrameSlow(t, (frame) => frame.includes("working"))

    t.mockInput.pressKey("o", { ctrl: true })
    await waitForFrameSlow(t, (frame) => frame.includes("PAGER"))

    t.mockInput.pressKey("c", { ctrl: true })
    await t.renderOnce()
    // Interrupting does not yank the view the user is reading.
    expect(t.captureCharFrame()).toContain("PAGER")

    t.mockInput.pressKey("o", { ctrl: true })
    const frame = await waitForFrameSlow(t, (f) => f.includes("turn interrupted"))
    expect(frame).toContain("Ctrl+C again to quit")
    t.renderer.destroy()
  } finally {
    provider.stop()
  }
}, 30_000)

test("Ctrl+C reaches the global handler with a picker open (the hoist, pinned twice)", async () => {
  const cwd = tempDir("bfly-tui-")
  writeFileSync(join(cwd, "notes.md"), "hello\n")
  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
    { width: 100, height: 32, exitOnCtrlC: false },
  )
  await t.renderOnce()
  let destroys = 0
  t.renderer.on("destroy", () => {
    destroys += 1
  })

  t.mockInput.typeText("look at @")
  await t.waitForFrame((frame: string) => frame.includes("mention a file"))

  t.mockInput.pressKey("c", { ctrl: true })
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(destroys).toBe(1)
  // Renderer already torn down — a second destroy() here would be a
  // double-teardown, so this test deliberately ends without one.
}, 30_000)

test("[ resumes the renderer even when the scrollback write throws", async () => {
  const cwd = tempDir("bfly-tui-")
  const sessionsDir = join(cwd, ".butterfly", "sessions")
  const journal = SessionJournal.create(sessionsDir, "pagerfix0005")
  journal.append({ type: "session.created", cwd, time: now() })
  journal.append({ type: "message.user", id: "u1", text: "dump me please", time: now() })

  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
    { width: 100, height: 40 },
  )
  await t.renderOnce()
  t.mockInput.typeText("/resume pagerfix0005")
  t.mockInput.pressEnter()
  await t.waitForFrame((frame: string) => frame.includes("resumed session"))

  t.mockInput.pressKey("o", { ctrl: true })
  await t.waitForFrame((frame: string) => frame.includes("PAGER"))

  const realSuspend = t.renderer.suspend
  const realResume = t.renderer.resume
  const realWrite = process.stdout.write
  let suspends = 0
  let resumes = 0
  t.renderer.suspend = () => {
    suspends += 1
  }
  t.renderer.resume = () => {
    resumes += 1
  }
  process.stdout.write = (() => {
    throw new Error("simulated scrollback write failure")
  }) as typeof process.stdout.write

  try {
    t.mockInput.pressKey("[")
    await waitForFrameSlow(t, (f) => f.includes("scrollback dump unavailable"))
  } finally {
    process.stdout.write = realWrite
    t.renderer.suspend = realSuspend
    t.renderer.resume = realResume
  }

  expect(suspends).toBe(1)
  expect(resumes).toBe(1)
  t.renderer.destroy()
}, 30_000)

test("teardown clears the OSC 9;4 progress indicator, and only on a TTY", () => {
  // renderer.destroy() cannot do this — OpenTUI has no progress concept — so
  // every TUI exit path (quit, Ctrl+C, crash) calls this instead.
  const tty: string[] = []
  clearTerminalProgress({
    isTTY: true,
    write: (chunk: string) => {
      tty.push(chunk)
      return true
    },
  })
  expect(tty).toEqual(["\x1b]9;4;0;0\x07"])

  const piped: string[] = []
  clearTerminalProgress({
    isTTY: false,
    write: (chunk: string) => {
      piped.push(chunk)
      return true
    },
  })
  expect(piped).toEqual([])
})

test("win32 console guard installs and stops without throwing", () => {
  const stop = installWin32ConsoleGuard()
  expect(typeof stop).toBe("function")
  stop()
  stop() // idempotent
})


test("Ctrl+J inserts a newline marker into the composer without submitting", async () => {
  const t = await testRender(
    () => (
      <App
        cwd={tempDir("bfly-tui-")}
        config={{ model: "mock/model" }}
        home={tempDir("bfly-home-")}
      />
    ),
    { width: 100, height: 32 },
  )
  await t.renderOnce()
  const submits = countSubmits(t)

  t.mockInput.typeText("line one")
  t.mockInput.pressKey("j", { ctrl: true })
  t.mockInput.typeText("line two")
  await t.renderOnce()

  expect(submits.composer.value).toBe(`line one${NEWLINE_MARKER}line two`)
  expect(submits.count()).toBe(0)
  t.renderer.destroy()
}, 30_000)

test("backslash+Enter inserts a newline without submitting", async () => {
  const t = await testRender(
    () => (
      <App
        cwd={tempDir("bfly-tui-")}
        config={{ model: "mock/model" }}
        home={tempDir("bfly-home-")}
      />
    ),
    { width: 100, height: 32 },
  )
  await t.renderOnce()
  const submits = countSubmits(t)

  t.mockInput.typeText("line one\\")
  t.mockInput.pressEnter()
  await t.renderOnce()
  expect(submits.composer.value).toBe(`line one${NEWLINE_MARKER}`)
  expect(submits.count()).toBe(0)

  t.mockInput.typeText("line two")
  t.mockInput.pressEnter()
  await t.renderOnce()
  expect(submits.count()).toBe(1)
  t.renderer.destroy()
}, 30_000)

test("a large single-line paste becomes a chip in the composer (real bracketed-paste event)", async () => {
  const t = await testRender(
    () => (
      <App
        cwd={tempDir("bfly-tui-")}
        config={{ model: "mock/model" }}
        home={tempDir("bfly-home-")}
      />
    ),
    { width: 120, height: 32 },
  )
  await t.renderOnce()
  await t.mockInput.pasteBracketedText("z".repeat(900))
  await t.renderOnce()
  expect(t.captureCharFrame()).toContain("[Pasted #1 +1 lines]")
  t.renderer.destroy()
}, 30_000)

test("a pasted image path is NOT chipped — the image-chip path still owns it", async () => {
  const cwd = tempDir("bfly-tui-")
  writeFileSync(join(cwd, "shot.png"), Buffer.from("fake-png-bytes"))
  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
    { width: 120, height: 32 },
  )
  await t.renderOnce()
  await t.mockInput.pasteBracketedText("shot.png")
  await t.waitForFrame((frame: string) => frame.includes("📎"))
  const frame = t.captureCharFrame()
  expect(frame).toContain("📎 1 image")
  expect(frame).not.toContain("[Pasted #")
  t.renderer.destroy()
}, 30_000)

function setComposerValue(composer: Composer, value: string): void {
  composer.value = value
}

test("submitting a message with two paste chips expands both payloads in order", async () => {
  const cwd = tempDir("bfly-tui-")
  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
    { width: 120, height: 34 },
  )
  await t.renderOnce()
  const composer = findComposer(t.renderer.root)
  if (!composer) throw new Error("composer not found")

  setComposerValue(composer, "A".repeat(900))
  await t.renderOnce()
  expect(composer.value).toBe("[Pasted #1 +1 lines]")

  t.mockInput.typeText(" and ")
  await t.renderOnce()

  setComposerValue(composer, `${composer.value}${"B".repeat(850)}`)
  await t.renderOnce()
  expect(composer.value).toBe("[Pasted #1 +1 lines] and [Pasted #2 +1 lines]")

  t.mockInput.pressEnter()
  await t.renderOnce()

  const frame = t.captureCharFrame()
  expect(frame).not.toContain("[Pasted #1")
  expect(frame).not.toContain("[Pasted #2")
  const aIndex = frame.indexOf("A".repeat(40))
  const bIndex = frame.indexOf("B".repeat(40))
  expect(aIndex).toBeGreaterThan(-1)
  expect(bIndex).toBeGreaterThan(aIndex)
  t.renderer.destroy()
}, 30_000)

test("backspace on a trailing chip deletes it atomically, not one character at a time", async () => {
  const cwd = tempDir("bfly-tui-")
  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
    { width: 120, height: 34 },
  )
  await t.renderOnce()
  const composer = findComposer(t.renderer.root)
  if (!composer) throw new Error("composer not found")

  setComposerValue(composer, "A".repeat(900))
  await t.renderOnce()
  expect(composer.value).toBe("[Pasted #1 +1 lines]")

  t.mockInput.pressBackspace()
  await t.renderOnce()
  // One keystroke removed the WHOLE label — a char-by-char backspace would
  // leave "[Pasted #1 +1 lines" (missing only the closing bracket).
  expect(composer.value).toBe("")
  t.renderer.destroy()
}, 30_000)

test("ordinary backspace (no trailing chip) still deletes one character, unchanged", async () => {
  const t = await testRender(
    () => (
      <App
        cwd={tempDir("bfly-tui-")}
        config={{ model: "mock/model" }}
        home={tempDir("bfly-home-")}
      />
    ),
    { width: 100, height: 32 },
  )
  await t.renderOnce()
  const composer = findComposer(t.renderer.root)
  if (!composer) throw new Error("composer not found")
  t.mockInput.typeText("hello")
  await t.renderOnce()
  t.mockInput.pressBackspace()
  await t.renderOnce()
  expect(composer.value).toBe("hell")
  t.renderer.destroy()
}, 30_000)

test("history recall after a chip-containing submit shows the fully expanded text", async () => {
  const t = await testRender(
    () => (
      <App
        cwd={tempDir("bfly-tui-")}
        config={{ model: "mock/model" }}
        home={tempDir("bfly-home-")}
      />
    ),
    { width: 120, height: 34 },
  )
  await t.renderOnce()
  const composer = findComposer(t.renderer.root)
  if (!composer) throw new Error("composer not found")

  t.mockInput.typeText("/help ")
  await t.renderOnce()
  setComposerValue(composer, `${composer.value}${"A".repeat(900)}`)
  await t.renderOnce()
  expect(composer.value).toBe("/help [Pasted #1 +1 lines]")

  t.mockInput.pressEnter()
  await t.renderOnce()

  t.mockInput.pressArrow("up")
  await t.renderOnce()
  expect(composer.value).toBe(`/help ${"A".repeat(900)}`)
  t.renderer.destroy()
}, 30_000)


/**
 * Starts a turn that never resolves in this sandbox (`mock/model` is not a
 * real provider) — i.e. leaves the app in exactly the `busy()` state a
 * QUEUED message gets composed in.
 */
async function startBusyTurn(t: {
  renderOnce: () => Promise<void>
  captureCharFrame: () => string
  mockInput: { typeText: (t: string) => void; pressEnter: () => void }
}): Promise<void> {
  t.mockInput.typeText("kick off a turn")
  t.mockInput.pressEnter()
  await t.renderOnce()
  if (!t.captureCharFrame().includes("thinking…")) {
    throw new Error(`expected a busy turn, frame was:\n${t.captureCharFrame()}`)
  }
}

test("a multi-line paste WHILE BUSY becomes a chip and the queued message keeps its newlines", async () => {
  const cwd = tempDir("bfly-tui-")
  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
    { width: 120, height: 34 },
  )
  await t.renderOnce()
  const composer = findComposer(t.renderer.root)
  if (!composer) throw new Error("composer not found")
  await startBusyTurn(t)

  await t.mockInput.pasteBracketedText("alphaAAAA\nbravoBBBB\ncharlieCC")
  await t.renderOnce()
  expect(composer.value).toBe("[Pasted #1 +3 lines]")

  t.mockInput.pressEnter()
  await t.renderOnce()
  const frame = t.captureCharFrame()
  expect(frame).toContain("⧗ queued (1)")
  expect(frame).toContain("alphaAAAA")
  expect(frame).toContain("charlieCC")
  expect(frame).not.toContain("alphaAAAAbravoBBBB")
  t.renderer.destroy()
}, 30_000)

test("the high-rate paste fallback also chips WHILE BUSY (no bracketed-paste terminals)", async () => {
  const cwd = tempDir("bfly-tui-")
  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
    { width: 120, height: 34 },
  )
  await t.renderOnce()
  const composer = findComposer(t.renderer.root)
  if (!composer) throw new Error("composer not found")
  await startBusyTurn(t)

  setComposerValue(composer, "Q".repeat(900))
  await t.renderOnce()
  expect(composer.value).toBe("[Pasted #1 +1 lines]")
  t.renderer.destroy()
}, 30_000)

test("Backspace away from the end edits normally — a trailing chip is not swallowed", async () => {
  const cwd = tempDir("bfly-tui-")
  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
    { width: 120, height: 34 },
  )
  await t.renderOnce()
  const composer = findComposer(t.renderer.root)
  if (!composer) throw new Error("composer not found")

  t.mockInput.typeText("hello")
  await t.renderOnce()
  setComposerValue(composer, `hello${"A".repeat(900)}`)
  await t.renderOnce()
  expect(composer.value).toBe("hello[Pasted #1 +1 lines]")

  // Ctrl+A = line-home, Ctrl+E = line-end in OpenTUI's default Textarea
  // bindings (nothing in app.tsx intercepts either).
  t.mockInput.pressKey("a", { ctrl: true })
  t.mockInput.pressArrow("right")
  t.mockInput.pressArrow("right")
  t.mockInput.pressArrow("right")
  t.mockInput.pressBackspace()
  await t.renderOnce()
  expect(composer.value).toBe("helo[Pasted #1 +1 lines]")

  t.mockInput.pressKey("e", { ctrl: true })
  t.mockInput.pressBackspace()
  await t.renderOnce()
  expect(composer.value).toBe("helo")
  t.renderer.destroy()
}, 30_000)

test("history recall of a multi-line entry keeps its line breaks, both directions", async () => {
  const cwd = tempDir("bfly-tui-")
  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
    { width: 120, height: 34 },
  )
  await t.renderOnce()
  const composer = findComposer(t.renderer.root)
  if (!composer) throw new Error("composer not found")

  // Routed through /help so the app never goes busy — history recall is
  // gated on !busy() (same reasoning as the expanded-recall test above).
  t.mockInput.typeText("/help ")
  t.mockInput.pressKey("j", { ctrl: true })
  t.mockInput.typeText("second")
  await t.renderOnce()
  expect(composer.value).toBe(`/help ${NEWLINE_MARKER}second`)
  t.mockInput.pressEnter()
  await t.renderOnce()

  t.mockInput.pressArrow("up")
  await t.renderOnce()
  expect(composer.value).toBe(`/help ${NEWLINE_MARKER}second`)

  // Re-submitting the recalled draft round-trips to the same expanded entry
  // — proof the newline survived all the way back through submit().
  t.mockInput.pressEnter()
  await t.renderOnce()
  t.mockInput.pressArrow("up")
  await t.renderOnce()
  expect(composer.value).toBe(`/help ${NEWLINE_MARKER}second`)

  // Down recall goes through the same conversion.
  t.mockInput.pressArrow("up")
  await t.renderOnce()
  expect(composer.value).toBe(`/help ${NEWLINE_MARKER}second`)
  t.mockInput.pressArrow("down")
  await t.renderOnce()
  expect(composer.value).toBe(`/help ${NEWLINE_MARKER}second`)
  t.renderer.destroy()
}, 30_000)

test("a chip whose label got edited out is reported at submit, never silently dropped", async () => {
  const cwd = tempDir("bfly-tui-")
  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
    { width: 120, height: 34 },
  )
  await t.renderOnce()
  const composer = findComposer(t.renderer.root)
  if (!composer) throw new Error("composer not found")

  setComposerValue(composer, "A".repeat(900))
  await t.renderOnce()
  expect(composer.value).toBe("[Pasted #1 +1 lines]")

  t.mockInput.pressArrow("left")
  t.mockInput.pressBackspace()
  await t.renderOnce()
  expect(composer.value).toBe("[Pasted #1 +1 line]")

  t.mockInput.pressEnter()
  await waitForFrameSlow(t, (frame: string) => frame.includes("no longer in the message"))
  t.renderer.destroy()
}, 30_000)


test("a multi-line paste DURING A PENDING APPROVAL chips — and y/n still resolves the approval", async () => {
  const cwd = tempDir("bfly-tui-")
  await gitFixture(cwd)
  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
    { width: 120, height: 34 },
  )
  await t.renderOnce()
  const composer = findComposer(t.renderer.root)
  if (!composer) throw new Error("composer not found")

  t.mockInput.typeText("/commit")
  t.mockInput.pressEnter()
  await waitForFrameSlow(t, (frame) => frame.includes("stage all tracked modifications"))

  await t.mockInput.pasteBracketedText("alphaAAAA\nbravoBBBB\ncharlieCC")
  await t.renderOnce()
  expect(composer.value).toBe("[Pasted #1 +3 lines]")
  // The paste neither answered nor dismissed the approval…
  expect(t.captureCharFrame()).toContain("stage all tracked modifications")

  // …and y/n still owns the keyboard: "n" resolves it, with the chip intact.
  t.mockInput.pressKey("n")
  await waitForFrameSlow(t, (frame) => frame.includes("commit cancelled"))
  expect(composer.value).toBe("[Pasted #1 +3 lines]")

  // The surviving chip expands normally at submit — payload not lost.
  t.mockInput.pressEnter()
  const frame = await waitForFrameSlow(t, (f) => f.includes("alphaAAAA"))
  expect(frame).toContain("charlieCC")
  expect(frame).not.toContain("alphaAAAAbravoBBBB")
  t.renderer.destroy()
}, 30_000)

test("atomic backspace works on a draft holding a ⏎ marker and an astral emoji (cursorOffset counts UTF-16 units)", async () => {
  const t = await testRender(
    () => (
      <App
        cwd={tempDir("bfly-tui-")}
        config={{ model: "mock/model" }}
        home={tempDir("bfly-home-")}
      />
    ),
    { width: 120, height: 34 },
  )
  await t.renderOnce()
  const composer = findComposer(t.renderer.root)
  if (!composer) throw new Error("composer not found")

  setComposerValue(composer, `a${NEWLINE_MARKER}b😀`)
  await t.renderOnce()
  setComposerValue(composer, `${composer.value}${"A".repeat(900)}`)
  await t.renderOnce()
  expect(composer.value).toBe(`a${NEWLINE_MARKER}b😀[Pasted #1 +1 lines]`)
  // Pin the accessor's unit directly: caret at end === String.length.
  expect(composer.cursorOffset).toBe(composer.value.length)

  t.mockInput.pressBackspace()
  await t.renderOnce()
  // One keystroke, whole label gone — a skipped gate would have left
  // "a⏎b😀[Pasted #1 +1 lines" (only the closing bracket deleted).
  expect(composer.value).toBe(`a${NEWLINE_MARKER}b😀`)
  t.renderer.destroy()
}, 30_000)

test("a pending handoff is preloaded on the first turn — and says so, naming the file", async () => {
  const cwd = tempDir("bfly-tui-")
  await gitFixture(cwd)
  const saved = saveHandoff(cwd, "## Goal\nBuild a widget\n", false, { append: () => {} })
  const provider = hangingProvider()
  try {
    const t = await testRender(
      () => (
        <App
          cwd={cwd}
          config={{ model: "hang/model", providers: { hang: { baseURL: provider.baseURL } } }}
          home={tempDir("bfly-home-")}
        />
      ),
      // Wide: the notice embeds an absolute path, and a wrapped line breaks
      // substring predicates for reasons this test isn't about.
      { width: 240, height: 30 },
    )
    await t.renderOnce()
    t.mockInput.typeText("carry on")
    t.mockInput.pressEnter()
    const frame = await waitForFrameSlow(t, (f) => f.includes("loaded the handoff"))
    expect(frame).toContain("handoff.md")
    expect(frame).toContain("just now")
    // Consumed exactly once: the pending pointer is retired.
    expect(existsSync(saved.path)).toBe(false)
    expect(existsSync(`${saved.path}.consumed`)).toBe(true)
    t.renderer.destroy()
  } finally {
    provider.stop()
  }
}, 30_000)

test("/handoff is metered like any other turn, and its own session never reinjects it", async () => {
  const cwd = tempDir("bfly-tui-")
  await gitFixture(cwd)
  const home = tempDir("bfly-home-")
  // A fresh models.dev cache so the TUI can actually PRICE this model:
  // $1,000,000 per 1M input tokens = $1/token, and the fake server reports
  // 5 prompt tokens → a $5.00 turn, unmissable in the status bar.
  const cacheDir = join(home, ".config", "butterfly")
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(
    join(cacheDir, "models-cache.json"),
    JSON.stringify({
      fetchedAt: Date.now(),
      data: {
        fake: { models: { "mock-handoff": { limit: { context: 100_000 }, cost: { input: 1e6 } } } },
      },
    }),
  )
  const server = startFakeChatServer("## Goal\nShip the widget\n## Continue with\nRun the tests")
  try {
    const t = await testRender(
      () => (
        <App
          cwd={cwd}
          config={{ model: "fake/mock-handoff", providers: { fake: { baseURL: server.baseURL } } }}
          home={home}
        />
      ),
      { width: 240, height: 30 },
    )
    await t.renderOnce()
    t.mockInput.typeText("/handoff")
    t.mockInput.pressEnter()
    const frame = await waitForFrameSlow(t, (f) => f.includes("handoff saved"), 25_000)
    expect(frame).toContain("$5.00")
    expect(existsSync(join(cwd, ".butterfly", "handoff.md"))).toBe(true)

    t.mockInput.typeText("one more thing")
    t.mockInput.pressEnter()
    const after = await waitForFrameSlow(t, (f) => f.includes("in 5 · out 3"), 25_000)
    expect(after).not.toContain("loaded the handoff")
    expect(existsSync(join(cwd, ".butterfly", "handoff.md"))).toBe(true)
    expect(existsSync(join(cwd, ".butterfly", "handoff.md.consumed"))).toBe(false)
    t.renderer.destroy()
  } finally {
    server.stop()
  }
}, 60_000)


test("/loop run renders a live card (iteration/queue/task) and Ctrl+C interrupts it, leaving the task claimed", async () => {
  const cwd = tempDir("bfly-tui-")
  await gitFixture(cwd)
  const queuePath = join(cwd, ".butterfly", "queue.db")
  const seed = WorkQueue.open(queuePath)
  const taskId = seed.addTask({ title: "stall task", spec: "do work" })
  seed.closeDb()
  const provider = hangingProvider()
  try {
    const t = await testRender(
      () => (
        <App
          cwd={cwd}
          config={{
            model: "hang/model",
            providers: { hang: { baseURL: provider.baseURL } },
            gates: [{ name: "ok", command: "exit 0" }],
          }}
          home={tempDir("bfly-home-")}
        />
      ),
      { width: 120, height: 40, exitOnCtrlC: false },
    )
    await t.renderOnce()

    t.mockInput.typeText("/loop run")
    t.mockInput.pressEnter()
    const running = await waitForFrameSlow(t, (frame) => frame.includes("loop running"))
    expect(running).toContain("iteration 1")
    expect(running).toContain("claimed 1")
    expect(running).toContain("stall task")
    expect(running).toContain("working")

    t.mockInput.pressKey("c", { ctrl: true })
    const message = await waitForFrameSlow(t, (frame) => frame.includes("loop interrupted"))
    expect(message).toContain("Ctrl+C again to quit")

    const settled = await waitForFrameSlow(t, (frame) => frame.includes("describe a task"), 15_000)
    expect(settled).not.toContain("loop running")

    t.renderer.destroy()

    const check = WorkQueue.open(queuePath)
    expect(check.get(taskId)?.status).toBe("open")
    check.closeDb()
  } finally {
    provider.stop()
  }
}, 30_000)

test("/loop run completes, summarizes the outcome into the transcript, and drains a queued message as an ordinary turn", async () => {
  const cwd = tempDir("bfly-tui-")
  await gitFixture(cwd)
  const queuePath = join(cwd, ".butterfly", "queue.db")
  const seed = WorkQueue.open(queuePath)
  seed.addTask({ title: "solo task", spec: "do the one thing" })
  seed.closeDb()
  const server = startFakeChatServer("done")
  try {
    const t = await testRender(
      () => (
        <App
          cwd={cwd}
          config={{
            model: "fake/mock-loop",
            providers: { fake: { baseURL: server.baseURL } },
            gates: [{ name: "ok", command: "exit 0" }],
          }}
          home={tempDir("bfly-home-")}
        />
      ),
      { width: 140, height: 40 },
    )
    await t.renderOnce()

    t.mockInput.typeText("/loop run")
    t.mockInput.pressEnter()
    t.mockInput.typeText("what happened while looping")
    t.mockInput.pressEnter()
    const queued = await waitForFrameSlow(t, (frame) => frame.includes("⧗ queued"))
    expect(queued).toContain("what happened while looping")

    const summary = await waitForFrameSlow(
      t,
      (frame) => frame.includes("loop stopped (drained)"),
      25_000,
    )
    expect(summary).toContain("1 closed, 0 blocked, 1 iteration")
    expect(summary).not.toContain("loop running")

    const drained = await waitForFrameSlow(t, (frame) => frame.includes("in 5 · out 3"), 25_000)
    expect(drained).toContain("❯ what happened while looping")

    t.renderer.destroy()
  } finally {
    server.stop()
  }
}, 60_000)

test("/loop status reads an idle queue when nothing has ever run, with no model or network needed", async () => {
  const cwd = tempDir("bfly-tui-")
  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
    { width: 100, height: 30 },
  )
  await t.renderOnce()

  t.mockInput.typeText("/loop status")
  t.mockInput.pressEnter()
  const frame = await waitForFrameSlow(t, (f) => f.includes("loop queue:"))
  expect(frame).toContain('"open":0')
  expect(frame).toContain('"claimed":0')
  expect(frame).toContain('"closed":0')
  expect(frame).toContain('"blocked":0')
  t.renderer.destroy()
})

test("plan mode denies /loop run (mutating) but still allows /loop plan (read-only)", async () => {
  const cwd = tempDir("bfly-tui-")
  const server = startFakeChatServer(
    '[{"title":"add tests","spec":"add unit tests for the parser"}]',
  )
  try {
    const t = await testRender(
      () => (
        <App
          cwd={cwd}
          config={{
            model: "fake/mock-plan",
            providers: { fake: { baseURL: server.baseURL } },
            gates: [{ name: "ok", command: "exit 0" }],
          }}
          home={tempDir("bfly-home-")}
        />
      ),
      { width: 140, height: 40 },
    )
    await t.renderOnce()

    t.mockInput.typeText("/plan")
    t.mockInput.pressEnter()
    await waitForFrameSlow(t, (f) => f.includes("plan mode ON"))

    t.mockInput.typeText("/loop run")
    t.mockInput.pressEnter()
    const denied = await waitForFrameSlow(t, (f) => f.includes("denied in plan mode"))
    expect(denied).not.toContain("loop running")
    expect(denied).not.toContain("working")

    t.mockInput.typeText("/loop plan add tests for the parser")
    t.mockInput.pressEnter()
    const planned = await waitForFrameSlow(t, (f) => f.includes("planned 1 task(s)"), 25_000)
    expect(planned).toContain("add tests")

    const queue = WorkQueue.open(join(cwd, ".butterfly", "queue.db"))
    expect(queue.counts().open).toBe(1)
    queue.closeDb()

    t.renderer.destroy()
  } finally {
    server.stop()
  }
}, 60_000)


/**
 * A fresh models.dev cache under the test's HOME, so catalog-driven pricing
 * is available with no network (ModelsCatalog.load short-circuits on a cache
 * younger than 24h). Costs are USD per 1M tokens.
 */
function seedCatalogCache(
  home: string,
  providerId: string,
  modelId: string,
  cost: { input: number; output: number },
): void {
  const dir = join(home, ".config", "butterfly")
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "models-cache.json"),
    JSON.stringify({
      fetchedAt: Date.now(),
      data: { [providerId]: { models: { [modelId]: { limit: { context: 128_000 }, cost } } } },
    }),
  )
}

test("/loop run refuses to start on a dirty working tree — nothing claimed, no supervisor", async () => {
  const cwd = tempDir("bfly-tui-")
  await gitFixture(cwd)
  writeFileSync(join(cwd, "app.ts"), "export const v = 999\n")
  const queuePath = join(cwd, ".butterfly", "queue.db")
  const seed = WorkQueue.open(queuePath)
  seed.addTask({ title: "stall task", spec: "do work" })
  seed.closeDb()

  const t = await testRender(
    () => (
      <App
        cwd={cwd}
        config={{ model: "mock/model", gates: [{ name: "ok", command: "exit 0" }] }}
        home={tempDir("bfly-home-")}
      />
    ),
    { width: 140, height: 40 },
  )
  await t.renderOnce()

  t.mockInput.typeText("/loop run")
  t.mockInput.pressEnter()
  const refused = await waitForFrameSlow(t, (f) => f.includes("/loop run refused"))
  expect(refused).toContain("app.ts")
  expect(refused).toContain("--allow-dirty")
  // The card never appeared: no supervisor was started.
  expect(refused).not.toContain("loop running")

  expect(existsSync(join(cwd, ".butterfly", "loop.jsonl"))).toBe(false)

  // busy cleared — the composer is usable again, not wedged.
  const idle = await waitForFrameSlow(t, (f) => f.includes("describe a task"))
  expect(idle).not.toContain("loop running")
  t.renderer.destroy()
}, 30_000)

test("/loop run --allow-dirty is an explicit, loud opt-out that does start the loop", async () => {
  const cwd = tempDir("bfly-tui-")
  await gitFixture(cwd)
  writeFileSync(join(cwd, "app.ts"), "export const v = 999\n")
  const queuePath = join(cwd, ".butterfly", "queue.db")
  const seed = WorkQueue.open(queuePath)
  seed.addTask({ title: "solo task", spec: "do the one thing" })
  seed.closeDb()
  const server = startFakeChatServer("done")
  try {
    const t = await testRender(
      () => (
        <App
          cwd={cwd}
          config={{
            model: "fake/mock-loop",
            providers: { fake: { baseURL: server.baseURL } },
            gates: [{ name: "ok", command: "exit 0" }],
          }}
          home={tempDir("bfly-home-")}
        />
      ),
      { width: 140, height: 40 },
    )
    await t.renderOnce()

    t.mockInput.typeText("/loop run --allow-dirty")
    t.mockInput.pressEnter()
    const warned = await waitForFrameSlow(t, (f) => f.includes("--allow-dirty: starting"))
    expect(warned).toContain("WILL be included")
    expect(warned).toContain("app.ts")

    const summary = await waitForFrameSlow(
      t,
      (frame) => frame.includes("loop stopped (drained)"),
      25_000,
    )
    expect(summary).toContain("1 closed")
    t.renderer.destroy()
  } finally {
    server.stop()
  }
}, 60_000)

test("/loop run warns that ask rules break unattended iterations and that maxSpendUSD is not enforced", async () => {
  const cwd = tempDir("bfly-tui-")
  await gitFixture(cwd)
  const t = await testRender(
    () => (
      <App
        cwd={cwd}
        config={{
          model: "mock/model",
          gates: [{ name: "ok", command: "exit 0" }],
          // The default-shaped tree a user actually ships with: every
          // ask-classified call would hard-error inside an unattended loop.
          permissions: { "*": "ask", bash: { "git *": "allow" } },
          maxSpendUSD: 5,
        }}
        home={tempDir("bfly-home-")}
      />
    ),
    { width: 140, height: 40 },
  )
  await t.renderOnce()

  // Empty queue: runLoop stops "drained" before any iteration, so this test
  // needs neither a model server nor a network at all.
  t.mockInput.typeText("/loop run")
  t.mockInput.pressEnter()
  const warned = await waitForFrameSlow(t, (f) => f.includes("UNATTENDED"), 20_000)
  expect(warned).toContain('"ask" entries')
  expect(warned).toContain("no-progress")
  // …and warn-and-proceed, not warn-and-block: the loop still ran.
  const capped = await waitForFrameSlow(t, (f) => f.includes("maxSpendUSD"), 20_000)
  expect(capped).toContain("$5.00")
  expect(capped).toContain("not enforced")
  const summary = await waitForFrameSlow(t, (f) => f.includes("loop stopped (drained)"), 20_000)
  expect(summary).toContain("0 closed")
  t.renderer.destroy()
}, 30_000)

test("/loop run meters its token usage into the session cost — a loop never reads as free", async () => {
  const cwd = tempDir("bfly-tui-")
  await gitFixture(cwd)
  const home = tempDir("bfly-home-")
  // $200/1M in and out; the fake server reports 5 prompt + 3 completion
  // tokens per call, so one iteration costs exactly (5+3) * 200 / 1e6 * 1e4…
  // => $1.60, a figure no other code path in this test can produce.
  seedCatalogCache(home, "fake", "mock-loop", { input: 200_000, output: 200_000 })
  const seed = WorkQueue.open(join(cwd, ".butterfly", "queue.db"))
  seed.addTask({ title: "solo task", spec: "do the one thing" })
  seed.closeDb()
  const server = startFakeChatServer("done")
  try {
    const t = await testRender(
      () => (
        <App
          cwd={cwd}
          config={{
            model: "fake/mock-loop",
            providers: { fake: { baseURL: server.baseURL } },
            gates: [{ name: "ok", command: "exit 0" }],
          }}
          home={home}
        />
      ),
      { width: 140, height: 40 },
    )
    await t.renderOnce()

    t.mockInput.typeText("/loop run")
    t.mockInput.pressEnter()
    const summary = await waitForFrameSlow(
      t,
      (frame) => frame.includes("loop stopped (drained)"),
      25_000,
    )
    // The status bar's session-cost readout (same accumulator ordinary turns
    // and /handoff feed) — credited live off LoopEvent.progress.usage, so it
    // is already correct on the frame the summary lands in.
    expect(summary).toContain("$1.60")
    t.renderer.destroy()
  } finally {
    server.stop()
  }
}, 60_000)


test("an approval that fires while the pager is open is NOT answerable by pager keys (incl. the [a] config write)", async () => {
  const cwd = tempDir("bfly-tui-")
  await stagedGitFixture(cwd)
  const server = startFakeChatServer("chore: pager modality test", { delayMs: 1_500 })
  const t = await testRender(
    () => (
      <App
        cwd={cwd}
        config={{ model: "fake/mock-commit", providers: { fake: { baseURL: server.baseURL } } }}
        home={tempDir("bfly-home-")}
      />
    ),
    { width: 240, height: 30 },
  )
  await t.renderOnce()
  t.mockInput.typeText("/commit")
  t.mockInput.pressEnter()
  await t.renderOnce()
  t.mockInput.pressKey("o", { ctrl: true })
  await waitForFrameSlow(t, (f) => f.includes("-- PAGER --"), 5_000)

  // The ask box renders BELOW the pager pane, so it is visible — but its keys
  // must not be live while the pager owns the keyboard.
  const asked = await waitForFrameSlow(t, (f) => f.includes("approve?"), 20_000)
  expect(asked).toContain("close the pager")

  // n/N are pager nav; "a" would apply the persistent quick-add; y would run
  // the commit. None of them may resolve the ask.
  t.mockInput.pressKey("a")
  t.mockInput.pressKey("y")
  t.mockInput.pressKey("n")
  await t.renderOnce()
  await new Promise((resolve) => setTimeout(resolve, 250))
  await t.renderOnce()
  expect(t.captureCharFrame()).toContain("approve?")
  expect(existsSync(join(cwd, "butterfly.jsonc"))).toBe(false)

  // Esc closes the pager; only then do the answer keys reach the ask.
  t.mockInput.pressEscape()
  await waitForFrameSlow(t, (f) => !f.includes("-- PAGER --"), 5_000)
  expect(t.captureCharFrame()).toContain("approve?")
  t.mockInput.pressKey("n")
  await waitForFrameSlow(t, (f) => !f.includes("approve?"), 10_000)
  expect(existsSync(join(cwd, "butterfly.jsonc"))).toBe(false)
  t.renderer.destroy()
  server.stop()
}, 60_000)


test("Ctrl+C during a real in-turn approval denies it, journals the paired tool.result, and unblocks the turn", async () => {
  const cwd = tempDir("bfly-tui-")
  await gitFixture(cwd)
  const server = startFakeToolCallServer("echo interrupted-approval")
  const t = await testRender(
    () => (
      <App
        cwd={cwd}
        config={{ model: "fake/mock-tools", providers: { fake: { baseURL: server.baseURL } } }}
        home={tempDir("bfly-home-")}
      />
    ),
    { width: 140, height: 30, exitOnCtrlC: false },
  )
  await t.renderOnce()
  t.mockInput.typeText("run the thing")
  t.mockInput.pressEnter()
  await waitForFrameSlow(t, (f) => f.includes("approve?"), 25_000)
  t.mockInput.pressKey("c", { ctrl: true })
  await waitForFrameSlow(t, (f) => f.includes("turn interrupted"), 15_000)
  // The prompt is gone (resolved, not parked) and the turn is no longer busy.
  expect(t.captureCharFrame()).not.toContain("approve?")

  const sessionsDir = join(cwd, ".butterfly", "sessions")
  const file = readdirSync(sessionsDir).find((name) => name.endsWith(".jsonl"))
  expect(file).toBeDefined()
  const { events } = SessionJournal.replay(join(sessionsDir, file ?? ""))
  const calls = events.filter((e) => e.type === "tool.call")
  const results = events.filter((e) => e.type === "tool.result")
  expect(calls.length).toBeGreaterThan(0)
  // Every journaled tool.call got its paired tool.result — no orphan
  // tool_use, which every provider rejects on the next assemble().
  expect(results.map((r) => (r.type === "tool.result" ? r.callId : ""))).toEqual(
    calls.map((c) => (c.type === "tool.call" ? c.callId : "")),
  )
  const denied = results.find((r) => r.type === "tool.result" && r.isError)
  expect(denied && denied.type === "tool.result" ? denied.output : "").toContain("bash")
  t.renderer.destroy()
  server.stop()
}, 60_000)

test("/review with a shell expression as its range is refused in the UI — no git, no file written", async () => {
  const cwd = tempDir("bfly-tui-")
  await gitFixture(cwd)
  const marker = join(cwd, "pwned.txt").split("\\").join("/")
  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
    { width: 160, height: 30 },
  )
  await t.renderOnce()
  t.mockInput.typeText(`/review $(touch ${marker})`)
  t.mockInput.pressEnter()
  const frame = await waitForFrameSlow(t, (f) => f.includes("git revision"))
  expect(frame).not.toContain("git failed")
  expect(frame).not.toContain("nothing to review")
  expect(existsSync(marker)).toBe(false)
  t.renderer.destroy()
}, 30_000)


/** "#8b8b8b" -> [139,139,139]; captureSpans hands back RGBA channels. */
function hexToInts(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.replace("#", ""), 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

function spanFgFor(
  t: { captureSpans: () => CapturedFrame },
  needle: string,
): [number, number, number] {
  for (const line of t.captureSpans().lines) {
    for (const span of line.spans) {
      if (span.text.includes(needle)) {
        const [r, g, b] = span.fg.toInts()
        return [r, g, b]
      }
    }
  }
  throw new Error(`no span containing ${JSON.stringify(needle)} in the captured frame`)
}

test("/theme light actually REPAINTS — a styled span's colour changes, not just the token store", async () => {
  const home = tempDir("bfly-home-")
  const t = await testRender(
    () => <App cwd={tempDir("bfly-tui-")} config={{ model: "mock/model" }} home={home} />,
    { width: 100, height: 30 },
  )
  await t.renderOnce()
  // The header wordmark's "butterfly " is painted with tokens.muted — the
  // store-level tests prove the token flips; this proves the pixels do.
  expect(spanFgFor(t, "butterfly")).toEqual(hexToInts(DARK_TOKENS.muted))

  t.mockInput.typeText("/theme light")
  t.mockInput.pressEnter()
  await waitForFrameSlow(t, (frame) => frame.includes("theme set to light"))
  expect(spanFgFor(t, "butterfly")).toEqual(hexToInts(LIGHT_TOKENS.muted))
  expect(LIGHT_TOKENS.muted).not.toBe(DARK_TOKENS.muted)
  t.renderer.destroy()
}, 30_000)
