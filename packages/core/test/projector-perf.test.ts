import { expect, test } from "bun:test"
import { now, type SessionEvent } from "../src/session/events"
import { foldTimeline } from "../src/session/projector"

/** n stacked undos: every turn is rewound right after it happens. */
function stackedRewinds(n: number): SessionEvent[] {
  const events: SessionEvent[] = []
  for (let i = 0; i < n; i++) {
    const start = events.length
    events.push({ type: "message.user", id: `u${i}`, text: `try ${i}`, time: now() })
    events.push({ type: "message.assistant", id: `a${i}`, text: `answer ${i}`, time: now() })
    events.push({ type: "session.rewound", toIndex: start, time: now() })
  }
  events.push({ type: "message.user", id: "final", text: "keep me", time: now() })
  return events
}

test("folding stacked rewinds is linear-ish, not exponential", () => {
  const events = stackedRewinds(40)
  const started = performance.now()
  const { entries } = foldTimeline(events)
  const elapsed = performance.now() - started
  // Every rewound turn is gone; only the final message survives.
  expect(entries.map((e) => e.event.type)).toEqual(["message.user"])
  // 2^40 re-folds would never finish; memoized it is milliseconds.
  expect(elapsed).toBeLessThan(250)
})

test("nested rewinds still fold to the same timeline as before", () => {
  const events: SessionEvent[] = [
    { type: "message.user", id: "u1", text: "one", time: now() },
    { type: "message.assistant", id: "a1", text: "1", time: now() },
    { type: "message.user", id: "u2", text: "two", time: now() },
    { type: "message.assistant", id: "a2", text: "2", time: now() },
    { type: "session.rewound", toIndex: 2, time: now() },
    { type: "message.user", id: "u3", text: "three", time: now() },
    { type: "session.rewound", toIndex: 0, time: now() },
    { type: "message.user", id: "u4", text: "four", time: now() },
  ]
  const texts = foldTimeline(events).entries.map((e) => ("text" in e.event ? e.event.text : ""))
  expect(texts).toEqual(["four"])
  const partial = foldTimeline(events.slice(0, 6)).entries.map((e) =>
    "text" in e.event ? e.event.text : "",
  )
  expect(partial).toEqual(["one", "1", "three"])
})
