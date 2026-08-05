import type { ProviderPort, TurnEvent, TurnRequest } from "../../src/provider/port"

/**
 * Scripted provider: each call to streamTurn consumes the next script.
 * Records every request for assertions. Test-only.
 */
export class MockProvider implements ProviderPort {
  readonly requests: TurnRequest[] = []
  private scripts: TurnEvent[][]

  constructor(scripts: TurnEvent[][]) {
    this.scripts = [...scripts]
  }

  async *streamTurn(request: TurnRequest): AsyncIterable<TurnEvent> {
    this.requests.push(request)
    const script = this.scripts.shift()
    if (!script) throw new Error("MockProvider: no script left for this call")
    yield* script
  }
}

export const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
