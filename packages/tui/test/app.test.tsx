import { expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { now, runCommand, SessionJournal } from "@butterfly/core"
import { testRender } from "@opentui/solid"
import { App, clearTerminalProgress, timelineToMessages } from "../src/app"
import { NEWLINE_MARKER } from "../src/paste"
import { installWin32ConsoleGuard } from "../src/terminal-win32"

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

function startFakeChatServer(replyText: string): { baseURL: string; stop: () => void } {
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
    fetch: () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
  })
  return { baseURL: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) }
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
    { width: 100, height: 40 },
  )
  await t.renderOnce()
  t.mockInput.typeText("/help")
  t.mockInput.pressEnter()
  await t.waitForFrame((frame: string) => frame.includes("/setup"))
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
    { width: 100, height: 40 },
  )
  await t.renderOnce()
  t.mockInput.typeText("/")
  await t.waitForFrame((frame: string) => frame.includes("↑↓ select"))
  t.mockInput.pressEnter()
  await t.waitForFrame((frame: string) => frame.includes("commands:"))
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
