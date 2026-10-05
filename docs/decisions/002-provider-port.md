# 002: One narrow provider port, implemented over the Vercel AI SDK

Status: accepted

## Context

Butterfly must work with many providers: OpenAI-compatible endpoints (which
also covers OpenRouter, NVIDIA NIM, Ollama, LM Studio, LiteLLM and others),
Anthropic (with prompt caching) and Google Gemini. Maintaining several
hand-written wire protocols side by side is a known source of churn.

## Options

1. Hand-write each provider protocol.
2. Use the AI SDK types throughout the engine.
3. Define our own narrow port and implement it once over the AI SDK.

## Decision

Option 3. The engine depends only on `ProviderPort`
(`streamTurn(request) -> AsyncIterable<TurnEvent>`). The single implementation
adapts the AI SDK's OpenAI-compatible, Anthropic and Google packages. Model
limits and pricing come from a cached models.dev catalog.

## Consequences

- No AI SDK types leak outside `packages/core/src/provider/`.
- A provider can later get a hand-written implementation without touching
  the engine.
- Provider quirks (field names, reasoning settings, error formats) are
  normalised in one place.
