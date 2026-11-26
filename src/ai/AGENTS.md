# AGENTS.md

## Scope

Provider-agnostic AI gateway, token tracking, and provider-specific adapters under `src/ai`.

## Guidelines

- Implement new providers by satisfying the contracts in `interfaces.ts` / `enhanced-interfaces.ts` and place them under `providers/<provider>/`.
- Initialise gateways through `AIGateway` or `getAIGatewayWithTokenTracking()`; avoid creating provider instances directly in routes.
- Read configuration via environment-aware helpers (e.g., `getEnvironment()` or `process.env`) at construction time so defaults match `AIGateway.fromEnvironment()`.
- Use the shared `logger` for diagnostics, and preserve existing structured logging fields (`provider`, `model`, `runId`, etc.).
- Maintain token accounting by wrapping provider calls with the middleware in `token-tracking-middleware.ts` when adding new operations.
- Keep provider adapters resilient: normalise API errors, use Hydrogen for standard Gemini text requests and the frozen `PREMIUM_TEXT_MODEL` for premium generation. Keep explicit caching and legacy model mapping out of these requests.
