/**
 * Cheap token estimate (chars/4) for budgeting decisions only, never billing;
 * real usage comes from provider responses.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
