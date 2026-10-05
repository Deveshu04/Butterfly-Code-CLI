import type { ProviderPort, TurnEvent, TurnRequest } from "./port"

/**
 * Deterministic, network-free `ProviderPort`, selected via model ref
 * "mock/<anything>". Used to smoke-test the compiled exe without a provider.
 */
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
