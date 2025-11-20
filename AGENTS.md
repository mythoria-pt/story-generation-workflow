# AGENTS.md — Copilot/Vibe Playbook

## 1. Quick Context

- **Runtime**: Node.js 22 (ESM) + Express, compiled with `tsc` and path aliases (`@/...`).
- **Purpose**: Run Google Cloud Workflows, talk to Google GenAI/OpenAI, persist progress in PostgreSQL, and publish text, art, audio, and print assets for the Mythoria platform.
- **Entrypoint**: `src/index.ts` registers middleware (notably `apiKeyAuth`), routes under `/ai`, `/audio`, `/api/*`, `/internal/*`, `/debug`, and performs graceful shutdowns.
- **Auth**: Every external route requires `x-api-key` matching `STORY_GENERATION_WORKFLOW_API_KEY`. There is no JWT or session fallback.
- **State stores**: `drizzle/` (story DB) and `drizzle-workflows/` (workflow metadata). Keep the sibling `mythoria-webapp` repo nearby for shared migrations and schema sync scripts.

## 2. Share-This-First Checklist

When you spin up another agent (or Copilot Workspace) paste the following facts so it stays unblocked:

1. **Environment files**: `.env.local` overrides `.env`, `.env.test` is wired through `src/tests/setup.ts`.
2. **Critical variables**: `DB_*`, `WORKFLOWS_DB_*`, `STORY_GENERATION_WORKFLOW_API_KEY`, `TEXT_PROVIDER`, `IMAGE_PROVIDER`, `GOOGLE_GENAI_*`, `OPENAI_*`, `STORAGE_BUCKET_NAME`, `GHOSTSCRIPT_BINARY`, `TEMP_DIR`.
3. **Commands must run via PowerShell**: every script assumes `pwsh` semantics (`&&` is invalid, use `;`).
4. **Database access**: migrations live next door (`../mythoria-webapp/drizzle`). Use the `schema:sync*.ps1` scripts before editing `src/db/schema/*`.
5. **Workflows**: YAML lives in `workflows/*.yaml`; deploy through `npm run deploy` or `npm run deploy:fast` (workflow only). Keep Cloud Run + Workflows in sync.
6. **Secrets**: real deployments fetch secrets from Google Secret Manager; local dev reads `.env`. Never log secret values, only flags (`hasKey: true`).

## 3. Prompting Patterns for Agents

- **Positive instructions**
  - Ask clarifying questions when requirements conflict or data is missing (e.g., “Should audit logs include token usage?”).
  - Mirror the repo’s conventions: two-space indentation, single quotes, named exports, no console logging outside tests.
  - Prefer modifying existing modules over adding new packages; challenge requests to add dependencies unless clearly justified.
- **Negative instructions**
  - Do not assume JWT auth, OAuth, or GraphQL exist here—they do not. Everything is API-key + REST.
  - Avoid editing generated SQL in `drizzle/` manually; use migrations or sync scripts.
  - Do not remove retry / safety guardrails unless explicitly asked; they are compliance requirements.
  - Never emit secrets or production URLs beyond what is already in the repo.

## 4. Runbooks (pick-and-go recipes)

### Local environment

```powershell
pwsh -NoProfile -Command "npm install"
pwsh -NoProfile -Command "cp .env.example .env"
pwsh -NoProfile -Command "npm run env:validate"
pwsh -NoProfile -Command "npm run dev"
```

- Want type safety? `npm run typecheck`.
- Jest unit tests? `npm test` (see `src/tests/setup.ts`).
- Lint/format? `npm run lint`, `npm run format`.

### Database + schema

- Story DB migrations come from the webapp repo; inside SGW use `npm run schema:sync` to pull latest generated schema files.
- To inspect DBs quickly without writes: `npm run db:studio` (opens Drizzle Kit UI).
- Workflow DB helpers mirror story DB commands: `npm run workflows-db:migrate`, `npm run workflows-db:push`.

### Workflows + deploys

- Full deploy (container + workflow): `npm run deploy`.
- Workflow-only update (YAML change, no new container): `npm run deploy:fast`.
- Logs (Cloud Run): `npm run logs` (batch) or `npm run logs:tail` (stream).
- Workflow execution helper: `npm run execute-workflow -- --storyId=<id> --runId=<id>`.

### AI + retry troubleshooting

- Safety blocks return 422 and set run status to `blocked`. Prompt rewrite template: `src/prompts/en-US/image-prompt-safety-rewrite.json`.
- Retry helpers live in `src/shared/retry-utils.ts`. Workflow YAML loops through retries (3 attempts, 60s delay) before surfacing `failed`.
- To inspect prompt rewrites, query `token_usage_tracking` for `action = 'prompt_rewrite'` or tail logs for `promptRewriteAttempted`.

### Print + CMYK

- Ghostscript + ICC profiles are required before running `src/services/cmyk-conversion.ts`.
- Setup scripts: `npm run setup-icc-profiles` (downloads profiles), `npm run test:cmyk` (local validation), `npm run cmyk:status` (health check).
- Print API entry: `/internal/print/generate` (see `src/routes/print.ts`). RGB + CMYK PDFs upload to the story folder in the storage bucket.

## 5. Quick Reference Tables

| Area             | File(s)                                                                                                     | Notes                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Auth             | `src/middleware/apiKeyAuth.ts`                                                                              | Rejects every request without `x-api-key`; no bypass even in dev.            |
| Workflows        | `workflows/story-generation.yaml`, `workflows/audiobook-generation.yaml`, `workflows/print-generation.yaml` | YAML is the source of truth for orchestration; keep comments minimal.        |
| AI Providers     | `src/ai/providers/google-genai/*`, `src/ai/providers/openai/*`                                              | Text + image share token tracking via `src/ai/token-tracking-middleware.ts`. |
| Prompt Templates | `src/prompts/images/*.json`, `src/prompts/en-US/*.json`                                                     | Conditional handlebars syntax; see `PromptService` for rendering rules.      |
| Storage          | `src/services/storage-singleton.ts`, `src/services/storage.ts`                                              | Wraps Google Cloud Storage client; prefer singleton to avoid socket churn.   |

## 6. Expectations for Contributions

- Challenge unclear tickets: if requirements contradict docs, flag them instead of guessing.
- When touching business logic, add or update Jest coverage in `src/tests/` and mention the relevant scripts in PR descriptions.
- Keep documentation synchronized (see `docs/README.md` for the index). If you create a new convention, add or update the closest `AGENTS.md` to keep future agents aligned.

Need more context? Read `docs/overview.md` for the narrative, `docs/ai.md` for retry/safety specifics, and `docs/deployment.md` before touching Cloud Run config.
