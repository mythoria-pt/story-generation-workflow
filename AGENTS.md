# AGENTS.md

## Overview
Story Generation Workflow is a Node.js 22+ service that orchestrates Google Cloud Workflows, AI providers (Google GenAI and OpenAI), and print tooling to produce stories with text, images, and optional narration. The runtime entrypoint is [`src/index.ts`](src/index.ts) where Express, middleware, routes, and graceful shutdown are configured.

## Setup commands
- Node.js: use v22 or newer (see `package.json` `engines.node`).
- Install dependencies: `npm install`.
- Start the TypeScript watcher for local development: `npm run dev` (runs `tsx watch src/index.ts`).
- Build the production bundle: `npm run build` (runs `tsc`, `tsc-alias`, and copies static assets into `dist/`).
- Launch the compiled build: `npm start`.
- Clean build artifacts: `npm run clean`.

## Environment configuration
### Local env files
- The config loader in [`src/config/environment.ts`](src/config/environment.ts) reads `.env.local` then `.env` for development, and `.env.test` is loaded from [`src/tests/setup.ts`](src/tests/setup.ts) when running Jest.
- Run `npm run env:validate` (`tsx src/config/validate-env.ts`) to print the resolved configuration and confirm required variables before starting the server.

### Required variables (validated by `envSchema`)
- `NODE_ENV` — one of `development`, `staging`, `production`, `test`.
- `PORT` — stringified port; defaults to `8080`.
- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` — PostgreSQL connection for story data.
- `GOOGLE_CLOUD_PROJECT_ID`, `GOOGLE_CLOUD_REGION` — Cloud Run / Workflows project metadata.
- `STORAGE_BUCKET_NAME` — Google Cloud Storage bucket used by [`StorageService`](src/services/storage.ts).

### Optional or defaulted variables
- Provider selection: `TEXT_PROVIDER`, `IMAGE_PROVIDER` (default `google-genai`).
- Google GenAI: `GOOGLE_GENAI_API_KEY`, `GOOGLE_GENAI_MODEL` (default `gemini-2.5-flash`), `GOOGLE_GENAI_IMAGE_MODEL` (default `gemini-2.5-flash-image-preview`), `GOOGLE_GENAI_CLOUD_REGION` (default `global`), `GOOGLE_GENAI_USE_VERTEX`, `GOOGLE_GENAI_FORCE_REST`, `GOOGLE_GENAI_DISABLE_IMAGEN_MAPPING`.
- OpenAI: `OPENAI_API_KEY`, `OPENAI_TEXT_MODEL`, `OPENAI_IMAGE_MODEL` (default `gpt-5`), `OPENAI_IMAGE_QUALITY` (default `low`).
- TTS: `TTS_PROVIDER` (currently only `openai`), `TTS_MODEL` (default `gpt-4o-mini-tts`), `TTS_VOICE` (default `nova`), `TTS_SPEED` (defaults to `0.9` but some utilities fall back to `1.0`), `TTS_LANGUAGE` (default `en-US`).
- Image sizing: `IMAGE_DEFAULT_WIDTH`, `IMAGE_DEFAULT_HEIGHT`, `IMAGE_CHAPTER_WIDTH`, `IMAGE_CHAPTER_HEIGHT`, `IMAGE_COVER_WIDTH`, `IMAGE_COVER_HEIGHT` (all default to 1024×1536).
- Prompt & context: `STORY_CONTEXT_MAX_CHARS` (defaults to `12000`).
- Diagnostics: `DEBUG_AI_FULL_PROMPTS`, `DEBUG_AI_FULL_RESPONSES`.
- Storage helpers: `TEMP_DIR`, `GHOSTSCRIPT_BINARY` for CMYK conversion in [`CMYKConversionService`](src/services/cmyk-conversion.ts).
- Notifications: `NOTIFICATION_ENGINE_URL`, `NOTIFICATION_ENGINE_API_KEY`.
- Legacy override: `IMAGE_GENERATION_MODEL` (remapped to Gemini when necessary).

### Additional runtime requirements
- `WORKFLOWS_DB` — separate PostgreSQL database for workflow metadata (`src/db/workflows-db.ts`).
- `STORY_GENERATION_WORKFLOW_API_KEY` — required for all external routes protected by [`apiKeyAuth`](src/middleware/apiKeyAuth.ts); `/debug` is intentionally left open.
- `GOOGLE_CLOUD` credentials must be available locally (service account JSON or `gcloud auth`) for Google SDKs in `@google-cloud/storage` and `@google-cloud/workflows`.

## Everyday commands
- Lint TypeScript sources: `npm run lint`. This script uses PowerShell (`powershell`/`pwsh`); on UNIX shells run `pwsh -File scripts/lint.ps1` or invoke `npx eslint src --ext .ts` directly if PowerShell is unavailable.
- Auto-fix lint issues: `npm run lint:fix`.
- Static type check: `npm run typecheck`.
- Format check: `npm run format`; auto-format with `npm run format:fix`.
- Unit tests: `npm test`. Watch mode: `npm run test:watch`. Coverage: `npm run test:coverage`.
- Environment validation: `npm run env:validate`.
- Database studio: `npm run db:studio` (Drizzle Kit).
- Start a Docker container locally: `npm run docker:build` then `npm run docker:run` (see `Dockerfile` for Ghostscript and Chrome dependencies).

## Database and schema management
- Story database migrations are executed with `npm run db:migrate` (`tsx -r dotenv/config src/db/migrate.ts`), which expects the shared migration folder from the sibling Mythoria webapp at `../mythoria-webapp/drizzle`. Keep that repository adjacent or adjust the path before running migrations.
- Generate SQL migrations for this service with `npm run db:generate` (requires `npm run build` first because `drizzle.config.ts` points at `dist/db/schema/index.js`). Use `npm run db:push` to apply them.
- Workflow-specific tables live in `drizzle-workflows/` and are managed with `npm run workflows-db:migrate`, `npm run workflows-db:generate`, and `npm run workflows-db:push`.
- Synchronize shared schema files from the Mythoria webapp by running `npm run schema:sync`, `npm run schema:sync-dry`, or `npm run schema:sync-verbose` (PowerShell scripts in `scripts/sync-schema.ps1`). These commands rewrite `src/db/schema/*.ts` and update the sync timestamp in `index.ts`.

## Cloud workflows and operations
- Declarative Google Cloud Workflows live under `workflows/*.yaml` and are consumed by `@google-cloud/workflows` clients in `src/services`.
- Deployment helpers under `scripts/` are PowerShell-based: `npm run deploy`, `npm run deploy:fast`, `npm run setup-secrets`, `npm run check-secrets`, and `npm run verify`. Use PowerShell Core (`pwsh`) on macOS/Linux.
- Logs and diagnostics: `npm run logs` and `npm run logs:tail` wrap `scripts/logs.ps1`, while `npm run get-logs` issues a `gcloud logging read` against the Cloud Run service defined in `service.json`.

## Architecture map
- `src/index.ts` boots Express, applies security middleware, registers routers, and wires graceful shutdown (`closeDatabaseConnection`).
- `src/routes/` contains Express routers. External routes (`/ai`, `/audio`, `/api/story-edit`, `/api/jobs`, `/`) are protected by `apiKeyAuth`; `/internal` handles orchestration callbacks; `/debug` exposes image tooling.
- `src/ai/` implements the provider-agnostic AI gateway, token tracking, and provider integrations (`providers/google-genai`, `providers/openai`).
- `src/services/` encapsulates business logic for stories, chapters, prompts, printing, notifications, token usage, etc., and talks to Drizzle ORM models defined in `src/db/schema`.
- `src/adapters/` holds integration code for external systems (Google Cloud, database helpers) and is separated from pure business logic.
- `src/shared/` contains reusable utilities and shared types; see its own `AGENTS.md` for guardrails.
- `src/workflows/` and `src/workers/` contain workflow helpers and background job processors used by async routes.
- `src/templates/` provides HTML/CSS/asset templates for print/PDF generation.
- `docs/` houses architectural deep dives, deployment notes, and feature documentation referenced by product teams.
- Database migrations reside in `drizzle/` (story DB) and `drizzle-workflows/` (workflow DB). The Docker and Cloud Run definitions are in `Dockerfile` and `service.json` respectively.

## Code style and conventions
- TypeScript is compiled in strict mode (`tsconfig.json`) with path aliases rooted at `src` (`@/...`). Use named exports where possible and keep imports aligned with the module boundaries above.
- Stick to two-space indentation, single quotes, and semicolons. Run `npm run format` (Prettier) and `npm run lint` (ESLint with `@typescript-eslint`) before committing.
- Prefer dependency-free utilities in `src/shared` for logic that can be reused by both services and routes; heavier integrations belong in `src/services` or adapters.
- Use the shared Winston logger from `src/config/logger.ts` for structured logging instead of `console.log` outside of tests.

## Testing
- Unit and integration tests live in `src/tests/` and run under Jest with `ts-jest` ESM support (`jest.config.js`, `jest.resolver.js`).
- Test setup (`src/tests/setup.ts`) loads `.env.test`, configures Google SDK mocks, and sets the Jest timeout to 30s. Provide fake keys or use `dotenv` to avoid hitting live services during tests.
- When tests create or mutate data, use Drizzle services to keep logic consistent with production code.

## Print and media tooling
- PDF and print preparation relies on `src/services/print.ts`, `src/services/cmyk-conversion.ts`, ICC profiles in `src/config/icc-profiles.json`, and paper metadata in `src/config/paper-caliper.json`. Ensure Ghostscript is installed and the `TEMP_DIR` directory is writable when running print flows locally.
- Text-to-speech functionality is provided by `src/services/tts.ts` and expects an OpenAI API key when `TTS_PROVIDER=openai`.

## PR guidelines
- Before opening a PR, run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run env:validate`. Update or add Jest tests in `src/tests/` when you change business logic or routing.
- Keep documentation in `docs/` synchronized with behaviour changes (e.g., workflows, print pipeline).
- Follow the directory boundaries above; add or update nested `AGENTS.md` files when introducing new conventions.
