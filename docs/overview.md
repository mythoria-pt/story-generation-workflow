# Story Generation Workflow — Overview

## Mission

Story Generation Workflow (SGW) coordinates Mythoria's AI storytelling pipeline. It receives a brief from first-party apps, fans out work to AI providers through Google Cloud Workflows, persists intermediate assets in PostgreSQL + Google Cloud Storage, and delivers text, illustrations, audio, and print-ready PDFs back to consumers.

## System Topology

```
Client (WebApp/Admin) → Pub/Sub topic → Cloud Workflow → SGW HTTP routes →
  ├─ AI Gateway (Google GenAI / OpenAI)
  ├─ Drizzle ORM (stories, runs, chapters, token usage)
  ├─ Google Cloud Storage (text/html archives, image binaries, PDF/Cmyk output, audio)
  └─ Notification Engine + downstream consumers
```

Key services:

- **Express API (`src/index.ts`)** — Registers routes, API key middleware, health endpoints, and graceful shutdown. External routes (`/ai`, `/audio`, `/api/story-edit`, `/api/jobs`, `/print`, `/debug`) are gated behind `apiKeyAuth`; `/internal` handles workflow callbacks.
- **Google Cloud Workflows (`workflows/*.yaml`)** — Drive orchestration for story generation, audiobook creation, and print packaging. Workflows invoke SGW routes at each step and enforce retry budgets.
- **Domain services (`src/services/*`)** — House business logic for stories, prompts, token accounting, TTS, printing, CMYK conversion, image editing, and background jobs.
- **AI gateway (`src/ai/*`)** — Provides provider-agnostic interfaces, token tracking, context management, and prompt rewrite fallbacks. Providers live in `src/ai/providers/{google-genai|openai}`.
- **Adapters + shared utilities** — `src/adapters/` wraps Google Cloud SDKs and Drizzle, while `src/shared/` stores pure helpers (retry classification, schema validators, logging helpers).

## Tech Stack

| Layer | Details |
| --- | --- |
| Runtime & Language | Node.js 22+, TypeScript (ESM, path aliases via `tsconfig.json`) |
| Web framework | Express with API-key auth middleware, no session/JWT support |
| Databases | PostgreSQL (story data via `drizzle/`), PostgreSQL workflows DB (`drizzle-workflows/`) |
| Orchestration | Google Cloud Workflows triggered from Pub/Sub topics |
| Storage | Google Cloud Storage buckets per story for HTML, images, PDFs, audio |
| AI Providers | Google GenAI (Gemini, Imagen) and OpenAI (GPT-4.x, DALL·E, TTS) behind the AI gateway |
| Print stack | Puppeteer HTML→PDF rendering, Ghostscript + ICC profiles for CMYK conversion |
| Observability | Structured JSON logging (`src/config/logger.ts`), Cloud Logging, token usage telemetry |

## Core Capabilities

- **End-to-end story orchestration** — Outline, write, illustrate, assemble, narrate, and print from a single workflow run.
- **Provider flexibility** — AI gateway swaps text/image providers per env while preserving token tracking and prompt history.
- **Multi-modal jobs** — `/api/jobs/*` enables async edits, translations, and image fixes without blocking Cloud Run workers.
- **Print-ready output** — Cover + interior PDFs plus CMYK conversions stored under each story’s folder.
- **Audiobook pipeline** — Chapter-level TTS writes `audioUri` fields directly to chapters, enabling resumable narration.
- **Editing + safety tooling** — Prompt rewrite templates, retry heuristics, and image-edit utilities keep runs compliant and recoverable.

## Workflow Lifecycle

1. **Request queued** – WebApp/Admin writes `stories` + `story_generation_runs` rows and publishes a Pub/Sub event.
2. **Workflow executes** – Cloud Workflow loads story metadata, calls `/internal/runs/:id` to mark `running`, and steps through phases (`generate_outline`, `write_chapters`, `generate_images`, `assemble`, etc.).
3. **AI gateway calls** – `/ai/*` endpoints proxy to Google GenAI or OpenAI, applying safety filters, prompt rewrites, and token tracking. Images retry up to three times, with 422 safety blocks routed through rewrite templates.
4. **Persistence + storage** – Internal routes save outlines, chapters, prompts, translation diffs, and asset URIs. Generated binaries land in Google Cloud Storage under `{storyId}/...`.
5. **Packaging** – `/internal/print/generate` renders HTML templates via Puppeteer, converts RGB PDFs to CMYK through Ghostscript, and stores both versions. Audiobook workflows stream TTS per chapter and persist URLs on chapter rows.
6. **Completion** – Workflow updates run status to `completed` / `blocked` / `failed`, triggers notification hooks, and emits telemetry.

## Data & Integrations

| Concern | Location | Notes |
| --- | --- | --- |
| Primary DB | `drizzle/` schema, accessed via `src/db/*` | Shared with `mythoria-webapp`; keep migrations in sync.
| Workflow DB | `drizzle-workflows/` | Tracks workflow executions, token usage, retries.
| Storage | `src/services/storage.ts` | Buckets contain text snapshots, prompts, HTML, RGB+CMYK PDFs, audio masters.
| Secrets | Google Secret Manager + `.env` | See `docs/deployment.md` for binding each secret into Cloud Run.
| Logging | `src/config/logger.ts` | JSON logs stream to Cloud Logging; `npm run logs[:tail]` wraps queries.
| Notifications | `src/services/notifications.ts` (if enabled) | Outbound requests keyed by `NOTIFICATION_ENGINE_URL` / `API_KEY`.

## Resiliency Highlights

- **Retry matrix** — Workflows retry transient image failures (HTTP 500/503/429/timeouts) three times with a 60-second delay. `src/shared/retry-utils.ts` classifies errors for routers/services.
- **Safety rewrite** — Image 422s trigger prompt rewrites via Google GenAI (`src/prompts/en-US/image-prompt-safety-rewrite.json`) and a final retry before marking run `blocked`.
- **Graceful degradation** — CMYK conversion falls back to RGB-only output on failure; audio workflow marks run `completed` even if individual chapters fail, recording issues in logs.
- **Singleton adapters** — `getAIGateway()` and `getStorageService()` prevent repeated initialization to keep Cloud Run cold starts small.

## Where to Go Next

- Development environment, commands, and debugging tips → `docs/development.md`.
- Release, IAM, and rollback procedures → `docs/deployment.md`.
- Route-level contract and payloads → `docs/api.md`.
- Prompt strategy, safety handling, and provider nuances → `docs/ai.md`.
- Print + CMYK stack → `docs/print.md`.
