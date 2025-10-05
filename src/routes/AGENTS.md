# AGENTS.md

## Scope

Express routers that expose HTTP endpoints under `src/routes`.

## Conventions

- Export a named router (e.g., `aiRouter`) created via `express.Router()`; do not instantiate the main app here.
- Validate request bodies and params with `zod` schemas before invoking services.
- Delegate business logic to modules in `src/services` / `src/shared` instead of issuing SQL or provider calls inline.
- Log errors and key actions through `logger` from `@/config/logger` so Cloud Run logs stay structured.
- Surface workflow failures via `workflowErrorHandler` utilities where available to keep error responses consistent with Workflows expectations.
- Keep routes stateless—derive configuration from `getEnvironment()` or environment variables on each request instead of caching mutable state.
