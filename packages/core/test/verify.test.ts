import { expect, test } from "bun:test"
import { now, type SessionEvent } from "../src/session/events"
import { describeVerification, verifyLatestTurn } from "../src/session/verify"

const t = now()
let n = 0
const user = (text: string, synthetic = false): SessionEvent => ({
  type: "message.user",
  id: `u${n++}`,
  text,
  ...(synthetic ? { synthetic: true } : {}),
  time: t,
})
const call = (name: string, input: unknown, isError = false): SessionEvent[] => {
  const id = `c${n++}`
  return [
    { type: "tool.call", callId: id, name, input, time: t },
    { type: "tool.result", callId: id, output: "x", isError, time: t },
  ]
}

test("an edit followed by a passing check is verified", () => {
  const v = verifyLatestTurn([
    user("fix it"),
    ...call("edit", { file_path: "src/a.ts" }),
    ...call("bash", { command: "bun test packages/core" }),
  ])
  expect(v).toEqual({ edited: ["src/a.ts"], checks: "passed", testsEdited: [] })
  expect(describeVerification(v)).toBe("verify: 1 file edited - checks passed after the last edit")
})

test("a later edit invalidates an earlier passing check; failures are reported", () => {
  expect(
    verifyLatestTurn([
      user("go"),
      ...call("edit", { file_path: "a.ts" }),
      ...call("bash", { command: "npm test" }),
      ...call("edit", { file_path: "b.ts" }),
    ]).checks,
  ).toBe("none")
  const failed = verifyLatestTurn([
    user("go"),
    ...call("edit", { file_path: "a.ts" }),
    ...call("bash", { command: "cargo test" }, true),
  ])
  expect(describeVerification(failed)).toContain("FAILED")
})

test("only the latest real user turn counts; auto-continue nudges stay inside it", () => {
  const v = verifyLatestTurn([
    user("old"),
    ...call("edit", { file_path: "old.ts" }),
    user("new"),
    ...call("edit", { file_path: "new.ts" }),
    user("[harness] keep going", true),
    ...call("bash", { command: "pytest -q" }),
  ])
  expect(v.edited).toEqual(["new.ts"])
  expect(v.checks).toBe("passed")
})

test("test files edited alongside source are flagged; non-check commands and failed edits are ignored", () => {
  const v = verifyLatestTurn([
    user("make tests pass"),
    ...call("edit", { file_path: "src/cart.ts" }),
    ...call("edit", { file_path: "src/cart.test.ts" }),
    ...call("edit", { file_path: "src/nope.ts" }, true),
    ...call("bash", { command: "ls -la" }),
  ])
  expect(v.edited).toEqual(["src/cart.ts", "src/cart.test.ts"])
  expect(v.testsEdited).toEqual(["src/cart.test.ts"])
  expect(describeVerification(v)).toBe(
    "verify: 2 files edited - no test/build/lint ran after the last edit (unverified) - test files changed too (src/cart.test.ts): check they were not weakened",
  )
  expect(describeVerification(verifyLatestTurn([user("chat")]))).toBe("")
})
