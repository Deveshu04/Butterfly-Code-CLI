import { expect, test } from "bun:test"
import { clearProgressOsc, decideAttention } from "../src/session/attention"

const focusedState = { focus: "focused" as const, cwd: "/home/user/my-repo" }
const blurredState = { focus: "blurred" as const, cwd: "/home/user/my-repo" }
const notifyOn = { notifications: true }
const notifyOff = { notifications: false }

// turn.start: title + indeterminate progress, always (focus-independent)

test("turn.start sets a busy title and starts indeterminate progress", () => {
  const actions = decideAttention({ kind: "turn.start" }, blurredState, notifyOn)
  expect(actions).toEqual([
    { type: "title", text: "busy — my-repo", osc: "\x1b]0;busy — my-repo\x07" },
    { type: "progress", osc: "\x1b]9;4;3;0\x07" },
  ])
})

test("turn.start behaves the same whether focused or blurred (title/progress unaffected by focus)", () => {
  expect(decideAttention({ kind: "turn.start" }, focusedState, notifyOn)).toEqual(
    decideAttention({ kind: "turn.start" }, blurredState, notifyOn),
  )
})

// turn.progress: percent-based OSC 9;4, only when percent is known

test("turn.progress with a known percent emits an exact OSC 9;4 percent sequence", () => {
  const actions = decideAttention({ kind: "turn.progress", percent: 42 }, blurredState, notifyOn)
  expect(actions).toEqual([{ type: "progress", osc: "\x1b]9;4;1;42\x07" }])
})

test("turn.progress clamps and rounds percent into [0, 100]", () => {
  expect(decideAttention({ kind: "turn.progress", percent: 137 }, blurredState, notifyOn)).toEqual([
    { type: "progress", osc: "\x1b]9;4;1;100\x07" },
  ])
  expect(decideAttention({ kind: "turn.progress", percent: -5 }, blurredState, notifyOn)).toEqual([
    { type: "progress", osc: "\x1b]9;4;1;0\x07" },
  ])
  expect(decideAttention({ kind: "turn.progress", percent: 12.6 }, blurredState, notifyOn)).toEqual(
    [{ type: "progress", osc: "\x1b]9;4;1;13\x07" }],
  )
})

test("turn.progress with no percent (budget unknown) yields no action", () => {
  expect(decideAttention({ kind: "turn.progress" }, blurredState, notifyOn)).toEqual([])
})

// turn.end: idle title + progress clear, always; notify gated by focus + config

test("turn.end while blurred with notifications on: title, progress clear, and a notify action", () => {
  const actions = decideAttention({ kind: "turn.end" }, blurredState, notifyOn)
  expect(actions).toEqual([
    { type: "title", text: "idle — my-repo", osc: "\x1b]0;idle — my-repo\x07" },
    { type: "progress", osc: "\x1b]9;4;0;0\x07" },
    {
      type: "notify",
      message: "turn finished",
      title: "butterfly code",
      osc: "\x1b]9;turn finished\x07\x1b]777;notify;butterfly code;turn finished\x07\x07",
    },
  ])
})

test("turn.end while focused: title and progress clear, but no notify (focus gate)", () => {
  const actions = decideAttention({ kind: "turn.end" }, focusedState, notifyOn)
  expect(actions).toEqual([
    { type: "title", text: "idle — my-repo", osc: "\x1b]0;idle — my-repo\x07" },
    { type: "progress", osc: "\x1b]9;4;0;0\x07" },
  ])
})

test("turn.end while blurred with notifications off: no notify action (config off switch)", () => {
  const actions = decideAttention({ kind: "turn.end" }, blurredState, notifyOff)
  expect(actions).toEqual([
    { type: "title", text: "idle — my-repo", osc: "\x1b]0;idle — my-repo\x07" },
    { type: "progress", osc: "\x1b]9;4;0;0\x07" },
  ])
})

test("turn.end includes a detail (e.g. loop outcome) in the notify message when given", () => {
  const actions = decideAttention(
    { kind: "turn.end", detail: "drained: 3 closed, 0 blocked" },
    blurredState,
    notifyOn,
  )
  const notify = actions.find((a) => a.type === "notify")
  expect(notify).toEqual({
    type: "notify",
    message: "turn finished: drained: 3 closed, 0 blocked",
    title: "butterfly code",
    osc: "\x1b]9;turn finished: drained: 3 closed, 0 blocked\x07\x1b]777;notify;butterfly code;turn finished: drained: 3 closed, 0 blocked\x07\x07",
  })
})

// approval.request: notify-only, gated by focus + config; no title/progress

test("approval.request while blurred with notifications on emits a notify action only", () => {
  const actions = decideAttention({ kind: "approval.request" }, blurredState, notifyOn)
  expect(actions).toEqual([
    {
      type: "notify",
      message: "approval needed",
      title: "butterfly code",
      osc: "\x1b]9;approval needed\x07\x1b]777;notify;butterfly code;approval needed\x07\x07",
    },
  ])
})

test("approval.request includes the detail (e.g. tool/target) in the message when given", () => {
  const actions = decideAttention(
    { kind: "approval.request", detail: "bash: rm -rf build" },
    blurredState,
    notifyOn,
  )
  expect(actions).toEqual([
    {
      type: "notify",
      message: "approval needed: bash: rm -rf build",
      title: "butterfly code",
      osc: "\x1b]9;approval needed: bash: rm -rf build\x07\x1b]777;notify;butterfly code;approval needed: bash: rm -rf build\x07\x07",
    },
  ])
})

test("approval.request while focused emits nothing (focus gate)", () => {
  expect(decideAttention({ kind: "approval.request" }, focusedState, notifyOn)).toEqual([])
})

test("approval.request while blurred with notifications off emits nothing (config off switch)", () => {
  expect(decideAttention({ kind: "approval.request" }, blurredState, notifyOff)).toEqual([])
})

// message sanitization: strip ANSI, collapse newlines, strip control chars, clamp

test("notify message strips ANSI escapes, collapses newlines, and strips control chars", () => {
  const detail = "line one\x1b[31m red \x1b[0m\nline two\x07\x00 done"
  const actions = decideAttention({ kind: "approval.request", detail }, blurredState, notifyOn)
  const notify = actions[0]
  expect(notify?.type).toBe("notify")
  expect((notify as { message: string }).message).toBe(
    "approval needed: line one red \nline two done".replace("\n", " "),
  )
})

test("notify message is clamped to 240 chars and title to 80 chars", () => {
  const longDetail = "x".repeat(500)
  const actions = decideAttention(
    { kind: "approval.request", detail: longDetail },
    blurredState,
    notifyOn,
  )
  const notify = actions[0] as { message: string; title: string }
  expect(notify.message.length).toBe(240)
  expect(notify.title.length).toBeLessThanOrEqual(80)
})

// title basename derivation

const hasControlChars = (text: string): boolean =>
  [...text].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)

test("title text strips control chars from the cwd basename (a BEL would end the OSC early)", () => {
  const actions = decideAttention(
    { kind: "turn.start" },
    { focus: "blurred", cwd: "/a/b/re\x07po\x1b[31m" },
    notifyOn,
  )
  expect(actions[0]).toEqual({
    type: "title",
    text: "busy — repo",
    osc: "\x1b]0;busy — repo\x07",
  })
})

test("title text strips a terminal-escape injection smuggled in via a directory name", () => {
  // A cloned repo can be named anything; an ESC in the basename would be
  // written verbatim to the terminal (headless writes it straight to stderr).
  const actions = decideAttention(
    { kind: "turn.end" },
    { focus: "focused", cwd: "/a/b/evil\x1b]0;pwned\x07" },
    notifyOn,
  )
  const title = actions[0] as { type: string; text: string; osc: string }
  expect(title.type).toBe("title")
  expect(hasControlChars(title.text)).toBe(false)
  // Exactly one ESC (the OSC introducer) and one BEL (the terminator).
  expect(title.osc.split("\x1b").length - 1).toBe(1)
  expect(title.osc.split("\x07").length - 1).toBe(1)
  expect(title.osc).toBe("\x1b]0;idle — evil]0;pwned\x07")
})

test("title text is clamped to 80 chars, same as notify titles", () => {
  const actions = decideAttention(
    { kind: "turn.start" },
    { focus: "blurred", cwd: `/a/${"x".repeat(200)}` },
    notifyOn,
  )
  const title = actions[0] as { text: string; osc: string }
  expect(title.text.length).toBe(80)
  expect(title.osc).toBe(`\x1b]0;${title.text}\x07`)
})

// abnormal-termination cleanup: the bare progress-clear sequence

test("clearProgressOsc is exactly the sequence turn.end uses to clear progress", () => {
  const endProgress = decideAttention({ kind: "turn.end" }, focusedState, notifyOn).find(
    (a) => a.type === "progress",
  )
  expect(endProgress).toBeDefined()
  expect(clearProgressOsc()).toBe("\x1b]9;4;0;0\x07")
  expect(clearProgressOsc()).toBe(endProgress?.osc ?? "")
})

test("title uses the cwd basename, stable across trailing slashes", () => {
  const a = decideAttention(
    { kind: "turn.start" },
    { focus: "blurred", cwd: "/a/b/project" },
    notifyOn,
  )
  const b = decideAttention(
    { kind: "turn.start" },
    { focus: "blurred", cwd: "/a/b/project/" },
    notifyOn,
  )
  expect(a[0]).toEqual({ type: "title", text: "busy — project", osc: "\x1b]0;busy — project\x07" })
  expect(a[0]).toEqual(b[0])
})
