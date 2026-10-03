import type { Usage } from "../session/events"

/** USD per 1M tokens — the models.dev cost shape. */
export interface ModelCost {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
}

export function computeCostUSD(usage: Usage, cost: ModelCost): number {
  const fresh = Math.max(0, usage.input - usage.cacheRead - usage.cacheWrite)
  return (
    (fresh * (cost.input ?? 0) +
      usage.output * (cost.output ?? 0) +
      usage.cacheRead * (cost.cacheRead ?? 0) +
      usage.cacheWrite * (cost.cacheWrite ?? 0)) /
    1_000_000
  )
}

export function formatUSD(amount: number): string {
  if (amount === 0) return "$0.00"
  if (amount < 0.01) return `$${amount.toFixed(4)}`
  return `$${amount.toFixed(2)}`
}
