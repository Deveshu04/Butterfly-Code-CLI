import type { ProviderPort, TurnEvent, TurnRequest } from "./port"

export class OfflineMockProvider implements ProviderPort {
  async *streamTurn(_request: TurnRequest): AsyncIterable<TurnEvent> {
    yield { type: "text-delta", text: "mock response — no live provider configured." }
    yield {
      type: "finish",
      reason: "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    }
  }
}
