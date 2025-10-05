# Mythoria Story Generation Workflow

Mythoria's Story Generation Workflow (SGW) service orchestrates narrative text, illustration, and narrated audio production for the platform. It runs on Google Cloud Run, coordinates Google Cloud Workflows, and exposes REST APIs consumed by Mythoria web properties and partner systems.

## Mythoria Ecosystem Fit

- **Mythoria WebApp** – initiates story runs, consumes generated assets, and renders real-time progress.
- **Mythoria Admin** – manages authors, templates, moderation decisions, and manual overrides for generation runs.
- **Story Generation Workflow** – this service; brokers AI calls, persists state, dispatches background jobs, and packages deliverables.
- **Notification Engine** – triggers user notifications based on SGW lifecycle events (run updates, asset availability).

## Key Capabilities

- **End-to-end story orchestration** – outlines, chapter drafts, illustration prompts, final narration, and print-ready packaging.
- **Provider-agnostic AI gateway** – Google GenAI and OpenAI support with runtime selection, guardrails, and token tracking.
- **Workflow-driven coordination** – Google Cloud Workflows and Pub/Sub events manage long-running generation pipelines.
- **Progress and quality telemetry** – run progress, token usage, retry counts, and error surfaces exposed to downstream consumers.
- **Multi-modal output management** – handles storage for text, images, PDFs, audio masters, and localized assets.
- **Operational safeguards** – API key enforcement, observability hooks, and graceful retry logic for transient failures.

## High-Level Architecture

- **Entry layer** – Express server (`src/index.ts`) with API-key middleware, health checks, and route grouping for AI, audio, print, async jobs, and internal utilities.
- **Workflow handlers** – `src/workflows/handlers.ts` receives Cloud Workflow callbacks, prepares domain inputs, and invokes services.
- **Domain services** – `src/services/` encapsulates story lifecycle management, run state transitions, prompt construction, TTS, storage, and progress tracking.
- **AI gateway** – `src/ai/` abstracts provider APIs, enforces model limits, injects token tracking, and exposes fallbacks.
- **Adapters & infrastructure** – `src/adapters/` wraps database access, Google Cloud clients, and storage operations via Drizzle ORM and SDK facades.
- **Workers** – `src/workers/` hosts long-running processors for translation, image editing, and text refinements invoked from Workflows or async jobs.
- **Shared domain logic** – `src/shared/` provides pure, dependency-free utilities, validators, and type definitions reused across services.
- **Templates & assets** – `src/templates/` holds HTML layouts and CMYK resources for print-ready exports.

## Workflow Lifecycle

1. **Trigger** – WebApp or Admin publishes a story request (Pub/Sub) and inserts run metadata in the shared PostgreSQL database.
2. **Orchestration** – Google Cloud Workflow executes generation steps and invokes SGW HTTP handlers.
3. **Narrative planning** – AI gateway produces outlines, character beats, and chapter descriptions using provider-specific prompts.
4. **Content production** – Chapters, illustrations, and audio scripts are generated in parallel via AI providers; results are persisted and stored in Cloud Storage.
5. **Quality gates** – Token usage, safety classifiers, and schema validators ensure outputs meet platform standards.
6. **Packaging & delivery** – TTS voiceovers, PDFs, and localized assets are assembled; SGW emits run status updates for Notification Engine consumption.

## Data & Integrations

- **Database** – Drizzle ORM models shared tables (`stories`, `runs`, `assets`, etc.) aligning with Mythoria's global schema.
- **Storage** – Google Cloud Storage buckets store intermediate prompts, generated images, CMYK assets, and final deliverables.
- **Secrets** – Google Secret Manager manages sensitive credentials referenced in Cloud Run deployments.
- **Observability** – Winston logging, structured health checks, and Cloud Logging integration support tracing and alerting.

## Extensibility Principles

- Add new AI providers by extending `src/ai/providers/` and registering through the gateway without altering domain modules.
- Introduce workflow steps via `docs/ARCHITECTURE.md`–aligned diagrams, new handlers in `src/workflows/`, and corresponding service methods.
- Maintain pure functions in `src/shared/` (see `src/shared/AGENTS.md`) to keep business logic portable across services.
- For new run states or notification hooks, update `src/services/progress-tracker.ts` and ensure downstream consumers handle the additions.

## Further Reading

- `AGENTS.md` – operational guide for automated code agents working in this repo.
- `docs/ARCHITECTURE.md` – diagrams and deeper component relationships.
- `docs/DEVELOPMENT.md` – local tooling, debugging flags, and contributor practices.
- `docs/DEPLOYMENT.md` – Cloud Run build/deploy workflows and secret management.
- `docs/TTS_IMPLEMENTATION.md` – narration pipeline details.
- `docs/PROGRESS_TRACKING_IMPLEMENTATION.md` – run telemetry contract.
