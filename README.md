# Mythoria Story Generation Workflow

Story Generation Workflow (SGW) orchestrates the AI pipeline that turns a request from Mythoria products into publishable prose, illustrations, audio, and print-ready assets. The service runs on Google Cloud Run, leans on Google Cloud Workflows for orchestration, and exposes locked-down HTTP routes that partner services call through API keys.

## Quick Start

- **Requirements**: Node.js 22+, pnpm or npm, PostgreSQL access shared with `mythoria-webapp`, Google Cloud credentials with permission to invoke Workflows and Storage, PowerShell (all local scripts are `.ps1`).
- **Bootstrap**:

```powershell
pwsh -NoProfile -Command "npm install"
pwsh -NoProfile -Command "cp .env.example .env"
pwsh -NoProfile -Command "npm run env:validate"
pwsh -NoProfile -Command "npm run dev"
```

Point the webapp or integration tests at `http://localhost:3000` with the same `STORY_GENERATION_WORKFLOW_API_KEY` you load locally.

## Why This Service Exists

- **Story lifecycle management** – Owns outlines, chapters, prompts, translations, TTS, and print packaging.
- **Provider-agnostic AI gateway** – Hot-swappable integrations with Google GenAI and OpenAI plus token tracking, retries, and safety rewrites.
- **Workflow coordination** – Cloud Workflows drives image/text/audio generation phases while this service persists state and surfaces progress.
- **Operational guardrails** – API-key enforcement, audit-friendly token usage tables, structured logging, and CMYK conversion tooling for the print line.

## Architecture Snapshot

- `src/index.ts` wires Express, security middleware, graceful shutdown, and route registration.
- `src/routes/` groups external APIs (`/ai`, `/audio`, `/api/story-edit`, `/api/jobs`, `/debug`) behind `apiKeyAuth`, plus internal and health routes.
- `src/ai/` implements the multi-provider gateway, context preservation, and token accounting; providers live in `src/ai/providers/*`.
- `src/services/` houses domain logic (stories, chapters, prompts, printers, retry helpers, notification dispatch).
- `src/workflows/` mirrors Google Cloud Workflow handlers, while `workflows/*.yaml` defines orchestration logic executed in GCP.
- `src/templates/` + Ghostscript produce RGB + CMYK PDFs; `src/services/tts.ts` handles audiobook generation via OpenAI TTS.

See `docs/overview.md` for the end-to-end flow diagram and dependency map.

## Documentation Map

- `docs/overview.md` – system narrative, workflow lifecycle, and component responsibilities.
- `docs/development.md` – local environment, common scripts, database + workflow testing tips.
- `docs/deployment.md` – Cloud Run + Workflows release checklist, IAM, and rollback guidance.
- `docs/api.md` – external/internal route contract, authentication rules, and sample payloads.
- `docs/ai.md` – provider strategy, prompt patterns, rewrite/safety flow, and retry matrix.
- `docs/print.md` – print/C++YK stack, Ghostscript requirements, troubleshooting tree.
- `docs/features.md` – product-level capability matrix for Mythoria stakeholders.
- `docs/backlog.md` – clean-up and follow-up tasks that have not moved to GitHub issues yet.

For automation guidance refer to `AGENTS.md`; for route-level implementation details browse `src/routes/*.ts`.
