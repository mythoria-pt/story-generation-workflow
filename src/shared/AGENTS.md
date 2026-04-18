# AGENTS.md

## Scope

Shared utilities, types, and services that are consumed by multiple layers (routes, services, workers).

## Guidelines

- Keep modules framework-agnostic: do not import Express routers or middleware from other layers.
- Prefer pure functions when possible, but allow controlled side effects (e.g., logging or database pings in `HealthService`) when they enable reuse.
- Import shared collaborators (`@/config/logger`, `@/config/environment`, `@/db/...`) directly rather than reaching into adapters or routes.
- Define cross-cutting types in `types.ts` / `interfaces.ts` and re-export them via `index.ts` for discovery.
- Utilities should remain unit-testable—extract external calls behind helper functions so tests can stub them easily.
