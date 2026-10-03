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
import { basename, join } from "node:path"
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
import { App, clearTerminalProgress, splitLabelValue, timelineToMessages } from "../src/app"
import { OSC52_BASE64_CAP, OSC52_TEXT_CAP_BYTES } from "../src/clipboard"
import { COPY_UNSUPPORTED_TEXT, copyStatusText } from "../src/format"
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


function sseChunk(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

function toolCallStreamBody(toolName: string, args: unknown, callId: string): string {
  return (
    sseChunk({
      id: "1",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: callId,
                type: "function",
                function: { name: toolName, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }) +
    sseChunk({
      id: "1",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    }) +
    "data: [DONE]\n\n"
  )
}

function textStreamBody(replyText: string): string {
  return (
    sseChunk({
      id: "1",
      choices: [
        { index: 0, delta: { role: "assistant", content: replyText }, finish_reason: null },
      ],
    }) +
    sseChunk({
      id: "1",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    }) +
    "data: [DONE]\n\n"
  )
}

function startFakeSequenceServer(
  bodies: string[],
  opts: { delayMs?: number } = {},
): { baseURL: string; stop: () => void } {
  let n = 0
  const server = Bun.serve({
    port: 0,
    fetch: async () => {
      if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs))
      const body = bodies[Math.min(n, bodies.length - 1)]
      n++
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    },
  })
  return { baseURL: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) }
}

function startFakeReasoningServer(
  reasoningText: string,
  replyText: string,
  opts: { delayMs?: number; holdMs?: number } = {},
): { baseURL: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      const stream = new ReadableStream({
        async start(controller) {
          const enc = new TextEncoder()
          controller.enqueue(
            enc.encode(
              sseChunk({
                id: "1",
                choices: [
                  {
                    index: 0,
                    delta: { role: "assistant", reasoning_content: reasoningText },
                    finish_reason: null,
                  },
                ],
              }),
            ),
          )
          if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs))
          controller.enqueue(
            enc.encode(
              sseChunk({
                id: "1",
                choices: [{ index: 0, delta: { content: replyText }, finish_reason: null }],
              }),
            ),
          )
          if (opts.holdMs) await new Promise((resolve) => setTimeout(resolve, opts.holdMs))
          controller.enqueue(
            enc.encode(
              sseChunk({
                id: "1",
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
              }),
            ),
          )
          controller.enqueue(enc.encode("data: [DONE]\n\n"))
          controller.close()
        },
      })
      return new Response(stream, { headers: { "content-type": "text/event-stream" } })
    },
  })
  return { baseURL: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) }
}

function startFakeReasoningThenErrorServer(reasoningText: string): {
  baseURL: string
  stop: () => void
} {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => {
      const body =
        sseChunk({
          id: "1",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", reasoning_content: reasoningText },
              finish_reason: null,
            },
          ],
        }) +
        sseChunk({ error: { message: "the upstream model fell over", type: "overloaded_error" } })
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    },
  })
  return { baseURL: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) }
}

function startFakeReasoningHangServer(reasoningText: string): {
  baseURL: string
  stop: () => void
} {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              sseChunk({
                id: "1",
                choices: [
                  {
                    index: 0,
                    delta: { role: "assistant", reasoning_content: reasoningText },
                    finish_reason: null,
                  },
                ],
              }),
            ),
          )
          // …and never closes.
        },
      })
      return new Response(stream, { headers: { "content-type": "text/event-stream" } })
    },
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

test("the narrow empty state is not a blank screen — it renders the plain wordmark + tagline centered", async () => {
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
  const bodyLines = frame.split("\n").slice(1)
  const body = bodyLines.join("\n")
  expect(body).toContain("butterfly")
  expect(body).toContain("code")
  expect(body).toContain("harness-first coding agent")
  t.renderer.destroy()
})

test("an open picker hides the big wordmark instead of clipping it mid-glyph", async () => {
  const t = await testRender(
    () => (
      <App
        cwd={tempDir("bfly-tui-")}
        config={{ model: "mock/model" }}
        home={tempDir("bfly-home-")}
      />
    ),
    // Wide enough that an empty session would otherwise show the big
    // block-pixel mark (wordmarkMode !== "plain").
    { width: 100, height: 32 },
  )
  await t.renderOnce()
  expect(t.captureCharFrame()).toContain("██")
  t.mockInput.typeText("/theme")
  t.mockInput.pressEnter()
  await t.waitForFrame((frame: string) => frame.includes("theme —"))
  expect(t.captureCharFrame()).not.toContain("██")
  t.renderer.destroy()
})

test("the status bar is never a dead row at idle — it shows model · cwd · a hint", async () => {
  const cwd = tempDir("bfly-tui-")
  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
    { width: 100, height: 30 },
  )
  await t.renderOnce()
  const frame = t.captureCharFrame()
  const lastLine =
    frame
      .split("\n")
      .filter((line) => line.trim() !== "")
      .at(-1) ?? ""
  expect(lastLine).toContain("mock/model")
  expect(lastLine).toContain(basename(cwd))
  expect(lastLine).toContain("/help")
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

  // provider by name: openai (needs key)
  t.mockInput.typeText("openai")
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

test("setup offers Sarvam first and saves a sarvam/ model ref with its key", async () => {
  const home = tempDir("bfly-home-")
  const t = await testRender(() => <App cwd={tempDir("bfly-tui-")} config={{}} home={home} />, {
    width: 100,
    height: 30,
  })
  await t.renderOnce()
  t.mockInput.typeText("1")
  t.mockInput.pressEnter()
  await t.waitForFrame((frame: string) => frame.includes("API key"))
  t.mockInput.typeText("sk-sarvam-abc")
  t.mockInput.pressEnter()
  await t.waitForFrame((frame: string) => frame.includes("Model id"))
  t.mockInput.typeText("sarvam-105b")
  t.mockInput.pressEnter()
  await t.waitForFrame((frame: string) => frame.includes("Ready on sarvam/sarvam-105b"))
  const saved = readFileSync(join(home, ".config", "butterfly", "butterfly.jsonc"), "utf8")
  expect(saved).toContain('"model": "sarvam/sarvam-105b"')
  expect(saved).toContain('"apiKey": "sk-sarvam-abc"')
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
    { width: 100, height: 64 },
  )
  await t.renderOnce()
  t.mockInput.typeText("/help")
  t.mockInput.pressEnter()
  await waitForFrameSlow(t, (frame: string) => frame.includes("/setup"))
  expect(t.captureCharFrame()).toContain("/quit")
  t.renderer.destroy()
})

test("/permissions shows the full rule set — the opening line is not scrolled out of view", async () => {
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
  t.mockInput.typeText("/permissions")
  t.mockInput.pressEnter()
  await waitForFrameSlow(t, (frame: string) => frame.includes('"web"'))
  const frame = t.captureCharFrame()
  const lines = frame.split("\n").map((line) => line.trim())
  const webIndex = lines.findIndex((line) => line.includes('"web"'))
  expect(webIndex).toBeGreaterThan(0)
  expect(lines.slice(0, webIndex)).toContain("{")
  t.renderer.destroy()
})

test("the transcript scrollbar reserves a gutter — a near-full-width line is never cut by the thumb", async () => {
  const cwd = tempDir("bfly-tui-")
  const marker = `${"a".repeat(90)}TAILMARKER`
  const server = startFakeSequenceServer([
    toolCallStreamBody("bash", { command: `echo ${marker}` }, "call1"),
    textStreamBody("done"),
  ])
  try {
    const t = await testRender(
      () => (
        <App
          cwd={cwd}
          config={{
            model: "fake/mock-h2",
            providers: { fake: { baseURL: server.baseURL } },
            permissions: { "*": "allow" },
          }}
          home={tempDir("bfly-home-")}
        />
      ),
      { width: 100, height: 20 },
    )
    await t.renderOnce()
    t.mockInput.typeText("/help")
    t.mockInput.pressEnter()
    await waitForFrameSlow(t, (frame: string) => frame.includes("/quit"))
    t.mockInput.typeText("echo it")
    t.mockInput.pressEnter()
    const frame = await waitForFrameSlow(t, (f: string) => f.includes("done"), 25_000)
    const lines = frame.split("\n")
    let sawFiller = false
    for (const line of lines) {
      const lastA = line.lastIndexOf("a")
      if (lastA === -1) continue
      sawFiller = true
      expect(line.length - 1 - lastA).toBeGreaterThanOrEqual(2)
    }
    expect(sawFiller).toBe(true)
    t.renderer.destroy()
  } finally {
    server.stop()
  }
}, 30_000)

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

test("/sessions drops dead '(empty session)' rows from past launches, keeping only the current one", async () => {
  const cwd = tempDir("bfly-tui-")
  for (let i = 0; i < 3; i++) {
    const past = await testRender(
      () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
      { width: 100, height: 30 },
    )
    await past.renderOnce()
    past.renderer.destroy()
  }
  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
    { width: 100, height: 30 },
  )
  await t.renderOnce()
  t.mockInput.typeText("/sessions")
  t.mockInput.pressEnter()
  await t.waitForFrame((frame: string) => frame.includes("sessions (newest first)"))
  const frame = t.captureCharFrame()
  const rows = frame.split("\n").filter((line) => /^\s*\d+\s+\d{4}-\d{2}-\d{2}/.test(line))
  expect(rows.length).toBe(1)
  expect(rows[0]).toContain("(current)")
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

test("/status and /doctor ellipsize an overlong journal path instead of wrapping it under the label column", async () => {
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
  t.mockInput.typeText("/status")
  t.mockInput.pressEnter()
  const statusFrame = await waitForFrameSlow(t, (f: string) => f.includes("last turn"))
  const statusLines = statusFrame.split("\n")
  const journalIndex = statusLines.findIndex((line) => line.trim().startsWith("journal"))
  expect(journalIndex).toBeGreaterThan(-1)
  expect(statusLines[journalIndex]).toContain("…")
  expect(statusLines[journalIndex + 1]?.trim().startsWith("last turn")).toBe(true)

  t.mockInput.typeText("/doctor")
  t.mockInput.pressEnter()
  const doctorFrame = await waitForFrameSlow(t, (f: string) => f.includes("config lint"))
  const doctorLines = doctorFrame.split("\n")
  const pathIndex = doctorLines.findIndex((line) => line.trim().startsWith("path"))
  expect(pathIndex).toBeGreaterThan(-1)
  expect(doctorLines[pathIndex]).toContain("…")
  expect(doctorLines[pathIndex + 1]?.trim().startsWith("events")).toBe(true)
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

test("the approval card is two lines — the question and the [y]es/[n]o answers never share a row", async () => {
  const cwd = tempDir("bfly-tui-")
  await gitFixture(cwd)
  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
    { width: 100, height: 30 },
  )
  await t.renderOnce()
  t.mockInput.typeText("/commit")
  t.mockInput.pressEnter()
  const frame = await waitForFrameSlow(t, (f) => f.includes("stage all tracked modifications"))
  const lines = frame.split("\n")
  const questionLine = lines.find((line) => line.includes("approve?"))
  const answerLine = lines.find((line) => line.includes("[y]es"))
  expect(questionLine).toBeDefined()
  expect(answerLine).toBeDefined()
  expect(questionLine).not.toBe(answerLine)
  expect(questionLine).not.toContain("[y]es")
  t.mockInput.pressKey("n")
  await waitForFrameSlow(t, (f) => f.includes("commit cancelled"))
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
  expect(frame).toContain('[a]lways "git *"')
  expect(frame).not.toContain("[a]lways bash:")
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
    { width: 100, height: 64 },
  )
  await t.renderOnce()
  t.mockInput.typeText("/")
  await t.waitForFrame((frame: string) => frame.includes("↑↓ select"))
  t.mockInput.pressEnter()
  await waitForFrameSlow(t, (frame: string) => frame.includes("commands:"))
  expect(t.captureCharFrame()).not.toContain("did you mean")
  t.renderer.destroy()
})


test("/res surfaces /resume first, and Enter opens the session picker", async () => {
  const cwd = tempDir("bfly-tui-")
  const past = SessionJournal.create(join(cwd, ".butterfly", "sessions"), "pickme0001")
  past.append({ type: "session.created", cwd, time: now() })
  past.append({ type: "message.user", id: "u1", text: "refactor the parser", time: now() })
  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
    { width: 100, height: 32 },
  )
  await t.renderOnce()
  t.mockInput.typeText("/res")
  await t.waitForFrame((frame: string) => frame.includes("↑↓ select"))
  expect(t.captureCharFrame()).toContain("/resume")
  t.mockInput.pressEnter()
  await waitForFrameSlow(t, (f: string) => f.includes("resume a session"))
  expect(t.captureCharFrame()).toContain("refactor the parser")
  t.mockInput.pressEnter()
  await waitForFrameSlow(t, (f: string) => f.includes("resumed session pickme00"))
  t.renderer.destroy()
})

test("/graph reports the code graph and the project map lands in .butterfly", async () => {
  const cwd = tempDir("bfly-tui-")
  writeFileSync(join(cwd, "widget.ts"), "export function buildWidgetTree() {\n  return 1\n}\n")
  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
    { width: 110, height: 40 },
  )
  await t.renderOnce()
  // The first sync runs in the background — wait for the map it writes.
  const mapPath = join(cwd, ".butterfly", "project-map.md")
  for (let i = 0; i < 100 && !existsSync(mapPath); i++) await new Promise((r) => setTimeout(r, 50))
  expect(readFileSync(mapPath, "utf8")).toContain("buildWidgetTree")
  t.mockInput.typeText("/graph")
  t.mockInput.pressEnter()
  await waitForFrameSlow(t, (f: string) => f.includes("project-map.md"))
  const frame = t.captureCharFrame()
  expect(frame).toMatch(/files\s+1/)
  expect(frame).toContain("explore op=map")
  t.renderer.destroy()
})

test("synonyms reach commands: /history opens the resume picker, /llm the model list", async () => {
  const cwd = tempDir("bfly-tui-")
  const t = await testRender(
    () => <App cwd={cwd} config={{ model: "mock/model" }} home={tempDir("bfly-home-")} />,
    { width: 100, height: 32 },
  )
  await t.renderOnce()
  t.mockInput.typeText("/history")
  await t.waitForFrame((frame: string) => frame.includes("↑↓ select"))
  expect(t.captureCharFrame()).toContain('matches "history"')
  t.mockInput.pressEnter()
  // No past sessions in a fresh dir — the picker says so instead of opening empty.
  await waitForFrameSlow(t, (f: string) => f.includes("no past sessions to resume yet"))
  t.renderer.destroy()
})

test("Tab-completing an alias-matched row completes to the alias, not the primary name", async () => {
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
  t.mockInput.typeText("/res")
  await t.waitForFrame((frame: string) => frame.includes("↑↓ select"))
  await t.mockInput.pressTab()
  await t.waitForFrame((frame: string) => frame.includes("/resume "))
  expect(t.captureCharFrame()).toContain("/resume")
  t.renderer.destroy()
})


test("the busy line ticks a live elapsed time, and the completed turn's marker gets a final duration suffix", async () => {
  const cwd = tempDir("bfly-tui-")
  await gitFixture(cwd)
  const server = startFakeChatServer("done", { delayMs: 1_500 })
  try {
    const t = await testRender(
      () => (
        <App
          cwd={cwd}
          config={{ model: "fake/mock-timer", providers: { fake: { baseURL: server.baseURL } } }}
          home={tempDir("bfly-home-")}
        />
      ),
      { width: 100, height: 30 },
    )
    await t.renderOnce()
    t.mockInput.typeText("hi")
    t.mockInput.pressEnter()
    await waitForFrameSlow(t, (frame) => frame.includes("thinking…"))
    const ticked = await waitForFrameSlow(
      t,
      (frame) => {
        const m = frame.match(/thinking… (\d+)s/)
        return m !== null && Number(m[1]) >= 1
      },
      3_000,
    )
    expect(ticked).toMatch(/thinking… \d+s/)
    const settled = await waitForFrameSlow(t, (frame) => frame.includes("in 5 · out 3"), 10_000)
    expect(settled).toMatch(/in 5 · out 3 · cached 0 · 1 steps · \d+s/)
    t.renderer.destroy()
  } finally {
    server.stop()
  }
}, 30_000)

test("/new clears any stale duration from the status bar — replay must never fabricate one", async () => {
  const cwd = tempDir("bfly-tui-")
  await gitFixture(cwd)
  const server = startFakeChatServer("done")
  try {
    const t = await testRender(
      () => (
        <App
          cwd={cwd}
          config={{ model: "fake/mock-timer2", providers: { fake: { baseURL: server.baseURL } } }}
          home={tempDir("bfly-home-")}
        />
      ),
      { width: 100, height: 30 },
    )
    await t.renderOnce()
    t.mockInput.typeText("hi")
    t.mockInput.pressEnter()
    await waitForFrameSlow(t, (frame) => /in 5 · out 3 · cached 0 · 1 steps · \d+s/.test(frame))
    t.mockInput.typeText("/new")
    t.mockInput.pressEnter()
    const after = await waitForFrameSlow(t, (frame) => frame.includes("fresh session started"))
    const lastLine =
      after
        .split("\n")
        .filter((l) => l.trim() !== "")
        .at(-1) ?? ""
    expect(lastLine).not.toContain("in 5 · out 3")
    expect(lastLine).not.toMatch(/\d+s\b/)
    expect(lastLine).toContain("/help for commands")
    t.renderer.destroy()
  } finally {
    server.stop()
  }
}, 30_000)


test("the ctx gauge right-aligns to the row's far edge, not clumped against the status text", async () => {
  const cwd = tempDir("bfly-tui-")
  await gitFixture(cwd)
  const server = startFakeChatServer("done")
  try {
    const t = await testRender(
      () => (
        <App
          cwd={cwd}
          config={{ model: "fake/mock-ctx", providers: { fake: { baseURL: server.baseURL } } }}
          home={tempDir("bfly-home-")}
        />
      ),
      { width: 100, height: 30 },
    )
    await t.renderOnce()
    t.mockInput.typeText("hi")
    t.mockInput.pressEnter()
    const frame = await waitForFrameSlow(t, (f) => f.includes("ctx 8"), 15_000)
    const lastLine =
      frame
        .split("\n")
        .filter((l) => l.trim() !== "")
        .at(-1) ?? ""
    const idx = lastLine.indexOf("ctx 8")
    expect(idx).toBeGreaterThan(-1)
    expect(lastLine.length - (idx + "ctx 8".length)).toBeLessThanOrEqual(2)
    expect(idx).toBeGreaterThan(20)
    t.renderer.destroy()
  } finally {
    server.stop()
  }
}, 30_000)

test("at narrow widths the meters drop instead of colliding with the status text", async () => {
  const cwd = tempDir("bfly-tui-")
  await gitFixture(cwd)
  const server = startFakeChatServer("done")
  try {
    const t = await testRender(
      () => (
        <App
          cwd={cwd}
          config={{
            model: "fake/mock-ctx-narrow",
            providers: { fake: { baseURL: server.baseURL } },
          }}
          home={tempDir("bfly-home-")}
        />
      ),
      { width: 60, height: 30 },
    )
    await t.renderOnce()
    t.mockInput.typeText("hi")
    t.mockInput.pressEnter()
    const frame = await waitForFrameSlow(
      t,
      (f) => /in 5 · out 3 · cached 0 · 1 steps · \d+s/.test(f),
      15_000,
    )
    const lastLine =
      frame
        .split("\n")
        .filter((l) => l.trim() !== "")
        .at(-1) ?? ""
    expect(lastLine).not.toContain("ctx ")
    t.renderer.destroy()
  } finally {
    server.stop()
  }
}, 30_000)


function stubClipboardApi(
  t: { renderer: unknown },
  opts: { supported?: boolean; ok?: boolean } = {},
) {
  const copied: string[] = []
  const renderer = t.renderer as unknown as {
    copyToClipboardOSC52: (text: string) => boolean
    isOsc52Supported: () => boolean
  }
  renderer.isOsc52Supported = () => opts.supported ?? true
  renderer.copyToClipboardOSC52 = (text: string) => {
    copied.push(text)
    return opts.ok ?? true
  }
  return copied
}

test("dragging over transcript text auto-copies through OpenTUI's public clipboard API, with a transient 'copied' status notice", async () => {
  const t = await testRender(
    () => <App cwd={tempDir("bfly-tui-")} config={{}} home={tempDir("bfly-home-")} />,
    { width: 100, height: 30 },
  )
  await t.renderOnce()
  const copied = stubClipboardApi(t)

  const lines = t.captureCharFrame().split("\n")
  const y = lines.findIndex((l) => l.includes("for commands"))
  expect(y).toBeGreaterThan(-1)
  const line = lines[y] ?? ""
  const x = line.indexOf("for commands")
  expect(x).toBeGreaterThan(-1)

  await t.mockMouse.drag(x, y, line.length - 1, y)
  await t.renderOnce()

  expect(copied.length).toBe(1)
  expect(copied[0]).toContain("for commands")

  const frame = await waitForFrameSlow(t, (f) => f.includes("copied"), 5_000)
  expect(frame).toContain("copied")
  t.renderer.destroy()
}, 30_000)

test("a click with no drag yields an empty selection — no clipboard write, no status noise", async () => {
  const t = await testRender(
    () => <App cwd={tempDir("bfly-tui-")} config={{}} home={tempDir("bfly-home-")} />,
    { width: 100, height: 30 },
  )
  await t.renderOnce()
  const copied = stubClipboardApi(t)
  const before = t.captureCharFrame()
  const lines = before.split("\n")
  const y = lines.findIndex((l) => l.includes("for commands"))
  const x = (lines[y] ?? "").indexOf("for commands")

  await t.mockMouse.click(x, y)
  await t.renderOnce()

  expect(copied.length).toBe(0)
  // The idle line is unchanged — no "copied" ever landed on it.
  expect(t.captureCharFrame()).not.toContain("copied")
  t.renderer.destroy()
})

test("an oversized selection is trimmed to the cap BEFORE the API sees it, with a truncation notice naming the real size", async () => {
  const t = await testRender(
    () => <App cwd={tempDir("bfly-tui-")} config={{}} home={tempDir("bfly-home-")} />,
    { width: 100, height: 30 },
  )
  await t.renderOnce()
  const copied = stubClipboardApi(t)
  const renderer = t.renderer as unknown as {
    emit: (event: string, ...args: unknown[]) => boolean
  }
  renderer.emit("selection", { getSelectedText: () => "y".repeat(250_000) })
  await t.renderOnce()

  expect(copied.length).toBe(1)
  // The cap is applied JS-side, so the native API never receives more than
  // the wire can carry.
  const payload = copied[0] ?? ""
  expect(Buffer.from(payload, "utf-8").length).toBe(OSC52_TEXT_CAP_BYTES)
  expect(Buffer.from(payload, "utf-8").toString("base64").length).toBeLessThanOrEqual(
    OSC52_BASE64_CAP,
  )

  const frame = await waitForFrameSlow(t, (f) => f.includes("selection truncated"), 5_000)
  expect(frame).toContain(copyStatusText(true))
  // The honest figure, not the base64 wire size.
  expect(frame).not.toContain("copied 100KB")
  t.renderer.destroy()
})

test("a terminal without OSC 52 gets an honest notice ONCE — never a false 'copied'", async () => {
  const t = await testRender(
    () => <App cwd={tempDir("bfly-tui-")} config={{}} home={tempDir("bfly-home-")} />,
    { width: 100, height: 30 },
  )
  await t.renderOnce()
  const copied = stubClipboardApi(t, { supported: false })
  const renderer = t.renderer as unknown as {
    emit: (event: string, ...args: unknown[]) => boolean
  }

  renderer.emit("selection", { getSelectedText: () => "some selected text" })
  renderer.emit("selection", { getSelectedText: () => "more selected text" })
  await t.renderOnce()

  // Gated: nothing was handed to the clipboard API at all.
  expect(copied.length).toBe(0)
  const frame = await waitForFrameSlow(t, (f) => f.includes(COPY_UNSUPPORTED_TEXT), 5_000)
  expect(frame).toContain(COPY_UNSUPPORTED_TEXT)
  // Never claims success.
  expect(frame).not.toContain("copied")
  // Once per session, not once per selection — two selections, one line.
  const occurrences = frame.split(COPY_UNSUPPORTED_TEXT).length - 1
  expect(occurrences).toBe(1)
  t.renderer.destroy()
}, 30_000)

test("a clipboard write that returns false makes no 'copied' claim", async () => {
  const t = await testRender(
    () => <App cwd={tempDir("bfly-tui-")} config={{}} home={tempDir("bfly-home-")} />,
    { width: 100, height: 30 },
  )
  await t.renderOnce()
  // Supported per the capability gate, but the native write itself fails.
  const copied = stubClipboardApi(t, { ok: false })
  const renderer = t.renderer as unknown as {
    emit: (event: string, ...args: unknown[]) => boolean
  }

  renderer.emit("selection", { getSelectedText: () => "some selected text" })
  await t.renderOnce()

  expect(copied.length).toBe(1) // it was attempted…
  expect(t.captureCharFrame()).not.toContain("copied") // …but never announced
  t.renderer.destroy()
})

test("a select-to-copy notice never becomes /status's 'last turn' — that stays the real turn marker", async () => {
  const cwd = tempDir("bfly-tui-")
  await gitFixture(cwd)
  const server = startFakeChatServer("done")
  try {
    const t = await testRender(
      () => (
        <App
          cwd={cwd}
          config={{ model: "fake/mock-copy", providers: { fake: { baseURL: server.baseURL } } }}
          home={tempDir("bfly-home-")}
        />
      ),
      { width: 100, height: 30 },
    )
    await t.renderOnce()
    stubClipboardApi(t)
    const renderer = t.renderer as unknown as {
      emit: (event: string, ...args: unknown[]) => boolean
    }

    // A real turn settles and writes the turn marker.
    t.mockInput.typeText("hi")
    t.mockInput.pressEnter()
    await waitForFrameSlow(t, (f) => /in 5 · out 3 · cached 0 · 1 steps/.test(f), 25_000)

    // Then a selection claims the transient status line.
    renderer.emit("selection", { getSelectedText: () => "some selected text" })
    const copiedFrame = await waitForFrameSlow(t, (f) => f.includes("copied"), 5_000)
    expect(copiedFrame).toContain("copied")

    // /status must still report the TURN, not the copy notice — the two
    // signals are separate (status bar = freshest, /status = last turn).
    t.mockInput.typeText("/status")
    t.mockInput.pressEnter()
    const statusFrame = await waitForFrameSlow(t, (f) => f.includes("last turn"), 10_000)
    const lastTurnLine = statusFrame.split("\n").find((l) => l.trim().startsWith("last turn")) ?? ""
    expect(lastTurnLine).toMatch(/in 5 · out 3 · cached 0 · 1 steps/)
    expect(lastTurnLine).not.toContain("copied")
    t.renderer.destroy()
  } finally {
    server.stop()
  }
}, 40_000)

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

test("/provider opens a picker showing (current) and [key] markers", async () => {
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
  expect(frame).toContain("[key]")
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
    () => <App cwd={tempDir("bfly-tui-")} config={{ model: "anthropic/claude-x" }} home={home} />,
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
  await t.waitForFrame((frame: string) => frame.includes("attached:"))
  const frame = t.captureCharFrame()
  expect(frame).toContain("attached: 1 image")
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
  await t.waitForFrame((frame: string) => frame.includes("attached: 1 image"))
  t.mockInput.typeText("b.jpg")
  await t.waitForFrame((frame: string) => frame.includes("attached: 2 images"))
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
  expect(frame).not.toContain("attached:")
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

test("opening the pager shows an honest 'rendering…' notice instead of a silent near-blank frame", async () => {
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
  const frame = await waitForFrameSlow(t, (f: string) => f.includes("PAGER"))
  expect(frame).toContain("rendering…")
  await waitForFrameSlow(t, (f: string) => !f.includes("rendering…"), 3_000)
  t.renderer.destroy()
})

test("the pager's own header row is not glued to the app header — there's a blank row of separation", async () => {
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
  const frame = await waitForFrameSlow(t, (f: string) => f.includes("PAGER"))
  const lines = frame.split("\n")
  const appHeaderIndex = lines.findIndex(
    (line) => line.includes("butterfly") && line.includes("code"),
  )
  const pagerHeaderIndex = lines.findIndex((line) => line.includes("-- PAGER --"))
  expect(appHeaderIndex).toBeGreaterThanOrEqual(0)
  expect(pagerHeaderIndex).toBeGreaterThan(appHeaderIndex)
  // At least one row of separation, not the very next row.
  expect(pagerHeaderIndex - appHeaderIndex).toBeGreaterThanOrEqual(2)
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
  await t.waitForFrame((frame: string) => frame.includes("attached:"))
  const frame = t.captureCharFrame()
  expect(frame).toContain("attached: 1 image")
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
  expect(frame).toContain("(queued) (1)")
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
    const queued = await waitForFrameSlow(t, (frame) =>
      frame.includes("what happened while looping"),
    )
    expect(queued).toContain("(queued)")

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


test("reasoning deltas render a live thinking block (height-capped to 3 lines) that collapses once the answer starts, and Ctrl+R expands/collapses it", async () => {
  const cwd = tempDir("bfly-tui-")
  await gitFixture(cwd)
  const server = startFakeReasoningServer(
    "alpha-reasoning\nbeta-reasoning\ngamma-reasoning\ndelta-reasoning",
    "final answer text",
    { delayMs: 800 },
  )
  try {
    const t = await testRender(
      () => (
        <App
          cwd={cwd}
          config={{
            model: "fake/mock-reasoning",
            providers: { fake: { baseURL: server.baseURL } },
          }}
          home={tempDir("bfly-home-")}
        />
      ),
      { width: 120, height: 34 },
    )
    await t.renderOnce()
    t.mockInput.typeText("think about it")
    t.mockInput.pressEnter()

    const streaming = await waitForFrameSlow(t, (frame) => frame.includes("beta-reasoning"))
    expect(streaming).toContain("thinking…")
    expect(streaming).toContain("delta-reasoning")
    expect(streaming).toContain("gamma-reasoning")
    expect(streaming).not.toContain("alpha-reasoning")
    expect(streaming).not.toContain("final answer text")

    // Collapses once the answer starts — no "thinking…" streaming header
    // left, no raw reasoning text, just the one-line summary.
    const collapsed = await waitForFrameSlow(t, (frame) => frame.includes("final answer text"))
    expect(collapsed).toMatch(/thought for \d+s/)
    expect(collapsed).not.toContain("thinking…")
    expect(collapsed).not.toContain("beta-reasoning")

    expect(spanFgFor(t, "thought for")).toEqual(hexToInts(DARK_TOKENS.muted))

    t.mockInput.pressKey("r", { ctrl: true })
    const expanded = await waitForFrameSlow(t, (frame) => frame.includes("alpha-reasoning"))
    expect(expanded).toContain("beta-reasoning")
    expect(expanded).toContain("gamma-reasoning")
    expect(expanded).toContain("delta-reasoning")

    t.mockInput.pressKey("r", { ctrl: true })
    await waitForFrameSlow(t, (frame) => !frame.includes("alpha-reasoning"))

    t.renderer.destroy()
  } finally {
    server.stop()
  }
}, 30_000)

test("an inline <think> block from a qwen-style model feeds the SAME thinking presentation instead of vanishing", async () => {
  const cwd = tempDir("bfly-tui-")
  await gitFixture(cwd)
  const server = startFakeChatServer("<think>\nqwen reasoning here\n</think>\nqwen final answer")
  try {
    const t = await testRender(
      () => (
        <App
          cwd={cwd}
          config={{
            model: "fake/mock-inline-think",
            providers: { fake: { baseURL: server.baseURL } },
          }}
          home={tempDir("bfly-home-")}
        />
      ),
      { width: 120, height: 34 },
    )
    await t.renderOnce()
    t.mockInput.typeText("think inline")
    t.mockInput.pressEnter()

    const settled = await waitForFrameSlow(t, (frame) => frame.includes("qwen final answer"))
    expect(settled).toContain("thought")
    expect(settled).not.toContain("qwen reasoning here")
    expect(settled).not.toContain("<think>")

    t.mockInput.pressKey("r", { ctrl: true })
    const expanded = await waitForFrameSlow(t, (frame) => frame.includes("qwen reasoning here"))
    expect(expanded).toContain("qwen final answer")

    t.renderer.destroy()
  } finally {
    server.stop()
  }
}, 30_000)

test("todo tool meta renders a card with glyphs + progress, and only the LATEST todo result keeps the card (recency)", async () => {
  const cwd = tempDir("bfly-tui-")
  await gitFixture(cwd)
  const server = startFakeSequenceServer(
    [
      toolCallStreamBody(
        "todo",
        {
          items: [
            { text: "first task", status: "in_progress" },
            { text: "second task", status: "pending" },
          ],
        },
        "call_1",
      ),
      toolCallStreamBody(
        "todo",
        {
          items: [
            { text: "first task", status: "completed" },
            { text: "second task", status: "in_progress" },
          ],
        },
        "call_2",
      ),
      textStreamBody("all done"),
    ],
    { delayMs: 300 },
  )
  try {
    const t = await testRender(
      () => (
        <App
          cwd={cwd}
          config={{ model: "fake/mock-todo", providers: { fake: { baseURL: server.baseURL } } }}
          home={tempDir("bfly-home-")}
        />
      ),
      { width: 120, height: 34 },
    )
    await t.renderOnce()
    t.mockInput.typeText("plan the work")
    t.mockInput.pressEnter()

    const firstCard = await waitForFrameSlow(t, (frame) => frame.includes("todos 0/2"))
    expect(firstCard).toContain("[~] first task")
    expect(firstCard).toContain("[ ] second task")

    const settled = await waitForFrameSlow(t, (frame) => frame.includes("all done"))
    expect(settled).toContain("todos 1/2")
    expect(settled).toContain("[x] first task")
    expect(settled).toContain("[~] second task")
    expect(settled).not.toContain("todos 0/2")

    expect(spanFgFor(t, "[~] second task")).toEqual(hexToInts(DARK_TOKENS.accent))

    t.mockInput.typeText("/theme light")
    t.mockInput.pressEnter()
    await waitForFrameSlow(t, (frame) => frame.includes("theme set to light"))
    expect(spanFgFor(t, "[~] second task")).toEqual(hexToInts(LIGHT_TOKENS.accent))
    expect(LIGHT_TOKENS.accent).not.toBe(DARK_TOKENS.accent)

    t.renderer.destroy()
  } finally {
    server.stop()
  }
}, 30_000)

test("bash results render a $ command cell with dim output and a right-aligned exit badge — ok on success, exit N on failure", async () => {
  const cwd = tempDir("bfly-tui-")
  await gitFixture(cwd)
  const server = startFakeSequenceServer([
    toolCallStreamBody("bash", { command: "echo alpha-success" }, "call_1"),
    toolCallStreamBody("bash", { command: "test -f /definitely/not/a/real/path" }, "call_2"),
    textStreamBody("done with both"),
  ])
  try {
    const t = await testRender(
      () => (
        <App
          cwd={cwd}
          config={{
            model: "fake/mock-bash-cell",
            providers: { fake: { baseURL: server.baseURL } },
          }}
          home={tempDir("bfly-home-")}
        />
      ),
      { width: 120, height: 34 },
    )
    await t.renderOnce()
    t.mockInput.typeText("run two commands")
    t.mockInput.pressEnter()

    await waitForFrameSlow(t, (f) => f.includes("approve?") && f.includes("alpha-success"))
    t.mockInput.pressKey("y")
    await waitForFrameSlow(t, (f) => f.includes("approve?") && f.includes("test -f"))
    t.mockInput.pressKey("y")

    const settled = await waitForFrameSlow(t, (frame) => frame.includes("done with both"))
    expect(settled).toContain("$ echo alpha-success")
    expect(settled).toContain("alpha-success")
    expect(settled).toContain("ok")
    expect(settled).toContain("$ test -f /definitely/not/a/real/path")
    expect(settled).toContain("exit 1")

    expect(spanFgFor(t, "exit 1")).toEqual(hexToInts(DARK_TOKENS.error))

    t.renderer.destroy()
  } finally {
    server.stop()
  }
}, 30_000)

test("a provider error renders a structured card from the classified error — kind-specific first line, no duplicate generic Error: line", async () => {
  const cwd = tempDir("bfly-tui-")
  await gitFixture(cwd)
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json(
        {
          error: {
            message: "Incorrect API key provided.",
            type: "invalid_request_error",
            code: "invalid_api_key",
          },
        },
        { status: 401 },
      ),
  })
  try {
    const t = await testRender(
      () => (
        <App
          cwd={cwd}
          config={{
            model: "fake/mock-error",
            providers: { fake: { baseURL: `http://127.0.0.1:${server.port}/v1` } },
          }}
          home={tempDir("bfly-home-")}
        />
      ),
      { width: 120, height: 34 },
    )
    await t.renderOnce()
    t.mockInput.typeText("hello")
    t.mockInput.pressEnter()

    const frame = await waitForFrameSlow(t, (f) => f.includes("invalid or missing API key"))
    // Kind-specific headline (auth, from the 401 status) plus the
    // actionability rule: auth errors point at /provider.
    expect(frame).toContain("error: invalid or missing API key (401) — /provider to update it")
    // Detail line: NOT deduped here (auth's headline never echoes the raw
    // provider message), so it shows as its own dim line below.
    expect(frame).toContain("Incorrect API key provided.")
    // Exactly ONE error line for this failure — the generic "Error: Provider
    // error: …" fallback must not ALSO have fired for the same rejection.
    expect(frame).not.toContain("Error: Provider error:")

    expect(spanFgFor(t, "invalid or missing API key")).toEqual(hexToInts(DARK_TOKENS.error))

    t.renderer.destroy()
  } finally {
    server.stop(true)
  }
}, 30_000)


test("a provider error mid-reasoning collapses the open thinking block instead of leaving it streaming under the error card", async () => {
  const cwd = tempDir("bfly-tui-")
  await gitFixture(cwd)
  const server = startFakeReasoningThenErrorServer(
    "alpha-reasoning\nbeta-reasoning\ngamma-reasoning",
  )
  try {
    const t = await testRender(
      () => (
        <App
          cwd={cwd}
          config={{
            model: "fake/mock-reasoning-error",
            providers: { fake: { baseURL: server.baseURL } },
          }}
          home={tempDir("bfly-home-")}
        />
      ),
      { width: 120, height: 34 },
    )
    await t.renderOnce()
    t.mockInput.typeText("think then break")
    t.mockInput.pressEnter()

    // Wait for the turn to be OVER (the idle composer placeholder), not just
    // for the card: while busy() the status bar prints its own "thinking… "
    // spinner, which would make the "no open block" assertion below ambiguous.
    const settled = await waitForFrameSlow(
      t,
      (frame) => frame.includes("describe a task") && frame.includes("provider unavailable"),
    )
    expect(settled).toContain("error: provider unavailable/overloaded — try again shortly")
    // …and the block above it is COLLAPSED: no streaming header, no rolling
    // reasoning preview. This turn never produced a text-delta, a tool-call
    // or a finish — the error event is the only close signal there was.
    expect(settled).toMatch(/thought for \d+s/)
    expect(settled).not.toContain("thinking…")
    expect(settled).not.toContain("beta-reasoning")

    t.renderer.destroy()
  } finally {
    server.stop()
  }
}, 30_000)

test("Ctrl+C mid-reasoning collapses the thinking block — an aborted turn ends with no finish AND no error event", async () => {
  const cwd = tempDir("bfly-tui-")
  await gitFixture(cwd)
  const server = startFakeReasoningHangServer("alpha-reasoning\nbeta-reasoning\ngamma-reasoning")
  try {
    const t = await testRender(
      () => (
        <App
          cwd={cwd}
          config={{
            model: "fake/mock-reasoning-abort",
            providers: { fake: { baseURL: server.baseURL } },
          }}
          home={tempDir("bfly-home-")}
        />
      ),
      { width: 120, height: 34, exitOnCtrlC: false },
    )
    await t.renderOnce()
    t.mockInput.typeText("think forever")
    t.mockInput.pressEnter()
    await waitForFrameSlow(t, (frame) => frame.includes("beta-reasoning"))

    t.mockInput.pressKey("c", { ctrl: true })
    const settled = await waitForFrameSlow(
      t,
      (frame) => frame.includes("turn interrupted") && frame.includes("describe a task"),
    )
    expect(settled).toMatch(/thought(?: for \d+s)?/)
    expect(settled).not.toContain("thinking…")
    expect(settled).not.toContain("beta-reasoning")

    t.renderer.destroy()
  } finally {
    server.stop()
  }
}, 30_000)

test("the turn-end sweep is idempotent — a block already collapsed by the answer keeps its frozen duration", async () => {
  const cwd = tempDir("bfly-tui-")
  await gitFixture(cwd)
  // The answer arrives immediately (block freezes at ~0s) but the FINISH
  // chunk is held back 2.5s, so a .finally that re-stamped thinkClosedAt
  // with a fresh now() could not possibly still read the same duration.
  const server = startFakeReasoningServer("idempotence-reasoning", "idempotent answer", {
    holdMs: 2_500,
  })
  try {
    const t = await testRender(
      () => (
        <App
          cwd={cwd}
          config={{
            model: "fake/mock-reasoning-idempotent",
            providers: { fake: { baseURL: server.baseURL } },
          }}
          home={tempDir("bfly-home-")}
        />
      ),
      { width: 120, height: 34 },
    )
    await t.renderOnce()
    t.mockInput.typeText("think briefly")
    t.mockInput.pressEnter()

    const mid = await waitForFrameSlow(t, (frame) => frame.includes("idempotent answer"))
    const frozen = mid.match(/thought for (\d+)s/)
    expect(frozen).not.toBeNull()

    const settled = await waitForFrameSlow(
      t,
      (frame) => frame.includes("describe a task") && frame.includes("idempotent answer"),
    )
    expect(settled).toContain(`thought for ${frozen?.[1]}s`)
    expect(settled).not.toContain("thinking…")

    t.renderer.destroy()
  } finally {
    server.stop()
  }
}, 30_000)


function spansOfLine(
  t: { captureSpans: () => CapturedFrame },
  lineNeedle: string,
): { text: string; fg: [number, number, number] }[] {
  for (const line of t.captureSpans().lines) {
    const text = line.spans.map((s) => s.text).join("")
    if (text.includes(lineNeedle)) {
      return line.spans.map((s) => {
        const [r, g, b] = s.fg.toInts()
        return { text: s.text, fg: [r, g, b] as [number, number, number] }
      })
    }
  }
  throw new Error(`no captured line containing ${JSON.stringify(lineNeedle)}`)
}

test("splitLabelValue splits at the FIRST 2+-space run, so a primary value is never left on the muted side", () => {
  expect(splitLabelValue("  system prompt   ~558 tok  █████")).toEqual({
    label: "  system prompt   ",
    value: "~558 tok  █████",
  })
  expect(splitLabelValue("  system prompt   ~558 tok")).toEqual({
    label: "  system prompt   ",
    value: "~558 tok",
  })
  // /doctor's journal block: label column, path/count is the value.
  expect(splitLabelValue("  path            ~/proj/.butterfly/sessions/a.jsonl")).toEqual({
    label: "  path            ",
    value: "~/proj/.butterfly/sessions/a.jsonl",
  })
  expect(splitLabelValue("  events          1,204")).toEqual({
    label: "  events          ",
    value: "1,204",
  })
  // /doctor's config-lint rows carry no column at all (single spaces) — they
  // must stay whole rather than be forced into a two-tone shape they lack.
  expect(
    splitLabelValue("  [unknown-model] mock/model is not in the models.dev catalog"),
  ).toBeUndefined()
  expect(splitLabelValue("doctor — context audit:")).toBeUndefined()
  expect(splitLabelValue("  1  2026-08-06 12:34  fix the bar  (current)")).toEqual({
    label: "  1  ",
    value: "2026-08-06 12:34  fix the bar  (current)",
  })
  expect(splitLabelValue("  /status                   show session status")).toEqual({
    label: "  /status                   ",
    value: "show session status",
  })
  // /status rows.
  expect(splitLabelValue("model      fake/cat-model")).toEqual({
    label: "model      ",
    value: "fake/cat-model",
  })
})

test("with a real catalog limit, /context's bar row paints the token count as primary content — only the label is muted", async () => {
  const home = tempDir("bfly-home-")
  seedCatalogCache(home, "fake", "cat-model", { input: 1, output: 2 })
  const t = await testRender(
    () => <App cwd={tempDir("bfly-tui-")} config={{ model: "fake/cat-model" }} home={home} />,
    { width: 120, height: 34 },
  )
  await t.renderOnce()
  await waitForFrameSlow(t, (frame) => frame.includes("128.0k"))
  t.mockInput.typeText("/context")
  t.mockInput.pressEnter()
  await waitForFrameSlow(t, (frame) => frame.includes("system prompt") && frame.includes("█"))

  const spans = spansOfLine(t, "system prompt")
  const muted = hexToInts(DARK_TOKENS.muted)
  const label = spans.find((s) => s.text.includes("system prompt"))
  const value = spans.find((s) => s.text.includes("tok"))
  expect(label).toBeDefined()
  expect(value).toBeDefined()
  expect(label?.fg).toEqual(muted)
  expect(value?.fg).not.toEqual(muted)
  t.renderer.destroy()
}, 30_000)

test("a tool-call row is a summarized one-liner, never a raw JSON dump", () => {
  // edit/read collapse to the path — the args object is fully suppressed
  // (the diff card two rows later already carries the content).
  const rows = timelineToMessages([
    {
      time: now(),
      type: "tool.call",
      callId: "c1",
      name: "edit",
      input: {
        file_path: "packages/tui/src/app.tsx",
        old_string: "export function greet(name) {",
        new_string: "export function greet(name: string): string {",
      },
    },
    {
      time: now(),
      type: "tool.call",
      callId: "c2",
      name: "grep",
      input: { pattern: "splitLabelValue", glob: "*.tsx" },
    },
    {
      time: now(),
      type: "tool.call",
      callId: "c3",
      name: "memory",
      input: { op: "search", query: "alpha ".repeat(40) },
    },
  ])
  expect(rows[0]?.text).toBe("edit packages/tui/src/app.tsx")
  expect(rows[0]?.text).not.toContain("old_string")
  expect(rows[0]?.text).not.toContain("{")
  expect(rows[0]?.isCall).toBe(true)
  expect(rows[1]?.text).toBe("grep splitLabelValue *.tsx")
  const fallback = rows[2]?.text ?? ""
  expect(fallback.startsWith("memory ")).toBe(true)
  expect(fallback.endsWith("…")).toBe(true)
  expect(fallback.length).toBeLessThan(120)
  expect(fallback).not.toContain("alph…")
})

test("the rendered call row shows the summary, not the JSON the model sent", async () => {
  const cwd = tempDir("bfly-tui-")
  await gitFixture(cwd)
  // `read` is auto-allowed by the TUI's default rules, so this reaches a real
  // rendered call row with no approval detour in the way.
  const server = startFakeSequenceServer([
    toolCallStreamBody("read", { file_path: "app.ts", offset: 0, limit: 2000 }, "call_r"),
    textStreamBody("read it"),
  ])
  try {
    const t = await testRender(
      () => (
        <App
          cwd={cwd}
          config={{ model: "fake/mock-toolrow", providers: { fake: { baseURL: server.baseURL } } }}
          home={tempDir("bfly-home-")}
        />
      ),
      { width: 140, height: 34 },
    )
    await t.renderOnce()
    t.mockInput.typeText("read the file")
    t.mockInput.pressEnter()
    const frame = await waitForFrameSlow(t, (f) => f.includes("read it"))
    expect(frame).toContain("read app.ts")
    expect(frame).not.toContain("file_path")
    t.renderer.destroy()
  } finally {
    server.stop()
  }
}, 30_000)

function startFakeErrorThenTextServer(
  ghostText: string,
  replyText: string,
): { baseURL: string; stop: () => void } {
  const doomed =
    sseChunk({
      id: "1",
      choices: [
        { index: 0, delta: { role: "assistant", content: ghostText }, finish_reason: null },
      ],
    }) + sseChunk({ error: { message: "the upstream model fell over", type: "overloaded_error" } })
  return startFakeSequenceServer([doomed, textStreamBody(replyText)])
}

test("a retried step retracts the doomed attempt's ghost text — the retry's answer stands alone, with the retry notice kept", async () => {
  const cwd = tempDir("bfly-tui-")
  await gitFixture(cwd)
  const server = startFakeErrorThenTextServer("GHOSTTEXT", "the real answer")
  try {
    const t = await testRender(
      () => (
        <App
          cwd={cwd}
          config={{ model: "fake/mock", providers: { fake: { baseURL: server.baseURL } } }}
          home={tempDir("bfly-home-")}
        />
      ),
      { width: 100, height: 30 },
    )
    await t.renderOnce()
    t.mockInput.typeText("hello")
    t.mockInput.pressEnter()

    // The retry breadcrumb is an INFO row, deliberately NOT retracted — the
    // user must still be told why the answer restarted.
    await waitForFrameSlow(t, (f) => f.includes("retrying (1/3)"))
    const settled = await waitForFrameSlow(t, (f) => f.includes("the real answer"))
    // The ghost is gone entirely — not merged into the real answer, not
    // lingering above it.
    expect(settled).not.toContain("GHOSTTEXT")
    expect(settled).toContain("retrying (1/3)")

    t.renderer.destroy()
  } finally {
    server.stop()
  }
}, 30_000)

test("butterfly.jsonc `retries: 0` reaches the runner from the TUI — the failure is not retried", async () => {
  const cwd = tempDir("bfly-tui-")
  await gitFixture(cwd)
  const errorBody = sseChunk({
    error: { message: "the upstream model fell over", type: "overloaded_error" },
  })
  const server = startFakeSequenceServer([errorBody])
  try {
    const t = await testRender(
      () => (
        <App
          cwd={cwd}
          config={{
            model: "fake/mock",
            providers: { fake: { baseURL: server.baseURL } },
            retries: 0,
          }}
          home={tempDir("bfly-home-")}
        />
      ),
      { width: 100, height: 30 },
    )
    await t.renderOnce()
    t.mockInput.typeText("hello")
    t.mockInput.pressEnter()

    const frame = await waitForFrameSlow(t, (f) => f.includes("provider unavailable"))
    expect(frame).not.toContain("retrying")

    t.renderer.destroy()
  } finally {
    server.stop()
  }
}, 30_000)
