type WorkflowStep = 'outline' | 'chapters' | 'images';

# Development Guide

## Prerequisites

- Node.js **22+** (ESM, top-level await). Use the `engines.node` version in `package.json` to avoid subtle build issues.
- PowerShell **pwsh** – every helper script in `scripts/*.ps1` assumes PowerShell semantics; avoid `&&`, prefer `;` or multiple commands.
- PostgreSQL – share the same story + workflow databases as `mythoria-webapp`. Keep that repo checked out next to this one for schema sync scripts.
- Google Cloud credentials – local runs need a service-account JSON or `gcloud auth application-default login` for Storage + Workflows.

## Environment setup

```powershell
pwsh -NoProfile -Command "npm install"

# populate STORY_GENERATION_WORKFLOW_API_KEY and DB_/WORKFLOWS_DB_ secrets
pwsh -NoProfile -Command "npm run env:validate"
```

Config loader order: `.env.local` → `.env` for dev, `.env.test` via `src/tests/setup.ts` for Jest. Validate before running so missing secrets fail fast.

## Everyday commands

| Intent        | Command                                                             |
| ------------- | ------------------------------------------------------------------- |
| Type checking | `pwsh -NoProfile -Command "npm run typecheck"`                      |
| Formatting    | `pwsh -NoProfile -Command "npm run format"` (add `:fix` to apply)   |
| Linting       | `pwsh -NoProfile -Command "npm run lint"`                           |
| Unit tests    | `pwsh -NoProfile -Command "npm test"` (watch: `npm run test:watch`) |
| Dev server    | `pwsh -NoProfile -Command "npm run dev"`                            |
| Build         | `pwsh -NoProfile -Command "npm run build"`                          |

All commands run through `npm run` wrappers so they pick up the repo’s tsconfig + path aliasing.

## Database & schema

- **Story DB migrations** live in `../mythoria-webapp/drizzle`. Keep that repo adjacent and run `npm run schema:sync` (see `scripts/sync-schema.ps1`) before editing `src/db/schema/*`. SGW only consumes the generated types.
- **Workflow DB** migrations sit in `drizzle-workflows/`. Use `npm run workflows-db:generate` + `npm run workflows-db:push` when you add workflow metadata tables or enums.
- **Studio access**: `pwsh -NoProfile -Command "npm run db:studio"` opens Drizzle Kit in read-only mode so you can inspect tables without writing SQL.

## Workflows & background jobs

- Workflow definitions: `workflows/story-generation.yaml`, `workflows/audiobook-generation.yaml`, `workflows/print-generation.yaml`.
- Deploy both container + workflow: `pwsh -NoProfile -Command "npm run deploy"`.
- Deploy workflow YAML only (no container rebuild): `pwsh -NoProfile -Command "npm run deploy:fast"`.
- Run a workflow locally via Cloud Workflows: `pwsh -NoProfile -Command "npm run execute-workflow -- --storyId=<id> --runId=<id>"`.
- Async job workers (`/api/jobs/*`) run inside the same process; long-lived loops belong in `src/workers/`.

### Audiobook pipeline highlights

- TTS generation is **database-driven**: `/audio` routes call `ChaptersService.updateChapterAudio()` so every chapter stores its own `audioUri`. Story-level `hasAudio` is toggled via `StoryService.updateStoryUris()` once `/audio/internal/audiobook/finalize` runs.
- `/internal/stories/:storyId/html` now reads sanitized chapter HTML directly from the DB (no HTML parsing). Keep migrations synced with `mythoria-webapp` before changing chapter fields.
- Google Workflow `audiobook-generation.yaml` fans out chapters in parallel; failures on one chapter fail fast so you can rerun the workflow without regenerating completed audio. Parallelism assumes the database always returns the latest chapter version.

## Testing playbook

1. **Unit/Integration** – Jest (`npm test`) bootstraps environment vars via `src/tests/setup.ts` and mocks Google SDKs.
2. **Routes** – For manual smoke tests use `scripts/execute-workflow.ps1` or fire off HTTP requests with `x-api-key` headers.
3. **Print/CMYK** – Install Ghostscript, run `pwsh -NoProfile -Command "npm run setup-icc-profiles"`, then `pwsh -NoProfile -Command "npm run test:cmyk"` to render sample PDFs.
4. **TTS/Audiobook** – `pwsh -NoProfile -Command "npm run test-openai"` (see `scripts/test-openai-integration.ts`) validates API keys before hitting `/audio` routes.

## Debugging tips

- **Logs**: `pwsh -NoProfile -Command "npm run logs"` for a snapshot, `npm run logs:tail` to stream Cloud Run logs. For targeted searches, `npm run logs -- --filter "promptRewriteAttempted"`.
- **Workflow state**: query `story_generation_runs` for `status`, `current_step`, and `error_message`. `token_usage_tracking` records every AI call, including `prompt_rewrite`.
- **Safety blocks**: look for 422 responses with `promptRewriteAttempted: true`. The rewrite template lives at `src/prompts/en-US/image-prompt-safety-rewrite.json`.
- **Storage debugging**: `getStorageService()` exposes `fileExists`, `getSignedUrl`, and `getPublicUrl`. Use the singleton to avoid exhausting sockets during debugging.

## Coding conventions

- Two-space indentation, single quotes, and named exports (`export const foo = …`).
- Keep shared logic dependency-free in `src/shared/`; once you need SDKs or state, pivot to `src/services/`.
- No `console.log` outside tests—use `logger` from `src/config/logger.ts`.
- When adding retry logic, reuse helpers from `src/shared/retry-utils.ts` to keep behavior consistent with the workflows.

## Operational hygiene

- **Daily cleanup job**: schedule a Cloud Scheduler hit (or manual run for now) that deletes up to 100 `story_generation_runs` + `story_generation_steps` rows older than 30 days in the workflows DB, and up to 100 `token_usage_tracking` rows older than 90 days. Keep the deletes batched to avoid long-running transactions.
- **Ephemeral stories**: Stories marked `status = 'temporary'` and older than 48 hours should be purged from the main DB to keep storage costs flat. Until an automated job exists, run manual SQL / scripts during on-call.
- When implementing the scheduler endpoint, gate it behind API-key auth and add generous logging so we can reconcile deletions if needed.

## When in doubt

- Cross-check desired behavior in `docs/overview.md` + `docs/ai.md`.
- If instructions contradict, ask for clarification before coding and capture the answer in the relevant doc or `AGENTS.md`.

```bash

```
