# API Reference

Story Generation Workflow exposes a small, opinionated REST surface for Mythoria services. The spec in `docs/openapi.yaml` mirrors everything below.

| Environment | Base URL                                                              |
| ----------- | --------------------------------------------------------------------- |
| Production  | `https://story-generation-workflow-803421888801.europe-west9.run.app` |
| Local dev   | `http://localhost:3000`                                               |

## Authentication

- External routes (`/ai`, `/audio`, `/api/story-edit`, `/api/jobs`, `/ping*`) require `x-api-key: <STORY_GENERATION_WORKFLOW_API_KEY>`.
- `/health`, `/`, `/debug/*`, `/internal/*`, and `/internal/print/*` are unauthenticated. Deploy behind VPC/Secure Web Proxy when exposed.
- No OAuth/JWT support. Rotate keys through Secret Manager and redeploy Cloud Run.

## External APIs (protected)

### AI text + media (`src/routes/ai.ts`)

| Endpoint                                | Description                                                                                                                              |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /ai/text/outline`                 | Generates outline, cover prompts, and character briefs from `storyId`/`runId`. Returns refined prompts for downstream image generation.  |
| `POST /ai/text/structure`               | Turns user description plus optional media (`imageObjectPath`, `audioObjectPath`, base64) into structured story metadata and characters. |
| `POST /ai/media/upload`                 | Accepts base64 + content type, stores in `storyId/inputs`, returns public URL.                                                           |
| `POST /ai/media/story-image-upload`     | Uploads user-supplied cover/back/chapter art, handling filename versioning (`*_v00n`).                                                   |
| `POST /ai/text/chapter/{chapterNumber}` | Generates chapter prose given outline context, prior chapters, and chapter synopsis.                                                     |
| `POST /ai/text/context/clear`           | Clears the chat context for `<storyId>:<runId>` once workflows finish.                                                                   |
| `POST /ai/image`                        | Creates cover/back/chapter illustrations. Automatically retries via safety rewrite logic; `422` signals `blocked`.                       |
| `GET /ai/test-text`                     | Smoke test for whichever provider `TEXT_PROVIDER` points to (Gemini/OpenAI).                                                             |

Sample image request:

```json
{
  "storyId": "c2f5...",
  "runId": "f41b...",
  "imageType": "chapter",
  "chapterNumber": 3,
  "prompt": "Moonlit river with two siblings on a raft",
  "graphicalStyle": "storybook"
}
```

Safety metadata surfaced on response:

```json
{
  "success": true,
  "image": { "filename": "..._v004.jpg", "url": "..." },
  "promptRewriteApplied": true,
  "originalPrompt": "...",
  "rewrittenPrompt": "..."
}
```

If both rewrite and fallback fail, the error payload includes `promptRewriteAttempted`, `promptRewriteError`, `fallbackAttempted`, and `fallbackError` so workflows can mark the run as `blocked`.

### Audio (`src/routes/audio.ts`)

| Endpoint                                  | Notes                                                                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `POST /audio/create-audiobook`            | Triggers the `audiobook-generation` Cloud Workflow for a story (`voice` defaults to `coral`).                         |
| `POST /audio/internal/audiobook/chapter`  | Workflow callback for per-chapter TTS generation. Requires chapter HTML plus metadata flags (e.g., `isFirstChapter`). |
| `POST /audio/internal/audiobook/finalize` | Aggregates stored chapter audio in GCS, updates story record with URLs.                                               |

Even though two endpoints live under `/audio/internal/*`, they still require the external API key because they share the `/audio` mount.

### Story editing (`src/routes/story-edit.ts`)

- `PATCH /api/story-edit/stories/{storyId}/chapters/{chapterNumber}`: Edits a single chapter per user instructions (1–2000 chars). Returns edited HTML and length metadata.
- `PATCH /api/story-edit/stories/{storyId}/chapters`: Applies the same instruction to every stored chapter, returning a per-chapter result array. Failures on individual chapters are surfaced inside the response payload; HTTP status remains 200.

### Async jobs (`src/routes/async-jobs.ts`)

| Endpoint                        | Description                                                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/jobs/text-edit`      | Enqueues a background job to edit one chapter (`scope: 'chapter'`) or an entire story (`scope: 'story'`).                    |
| `POST /api/jobs/image-edit`     | Creates an async image edit/replacement job. Supports `userImageUri` conversions and styled replacements (`convertToStyle`). |
| `POST /api/jobs/translate-text` | Translates all chapters to `targetLocale`. Rejects if the locale matches the current story language.                         |
| `GET /api/jobs/{jobId}`         | Returns status, simulated progress, and optional result/error blob.                                                          |

All job creation responses follow:

```json
{
  "success": true,
  "jobId": "4a0f...",
  "estimatedDuration": 90000
}
```

### Ping + diagnostics

| Endpoint                 | Auth    | Purpose                                                                                         |
| ------------------------ | ------- | ----------------------------------------------------------------------------------------------- |
| `GET /ping`              | API key | Lightweight liveness + version info.                                                            |
| `POST /ping/pubsub-test` | API key | Simulates a Pub/Sub publish to validate connectivity.                                           |
| `POST /test/pubsub-ping` | API key | Echo endpoint used by the web app to test Pub/Sub round trips.                                  |
| `GET /health`            | none    | Aggregated database, storage, AI, and internet health checks. Returns 503 when any probe fails. |
| `GET /`                  | none    | Static banner (`message`, `version`, `environment`).                                            |

Sample `/ping` output:

```json
{
  "success": true,
  "service": "story-generation-workflow",
  "status": "healthy",
  "version": "0.1.0"
}
```

## Internal + print APIs (unauthenticated)

Mounted via `/internal` without the API key middleware. Restrict ingress at the network layer.

| Endpoint                                           | Method    | Purpose                                                                            |
| -------------------------------------------------- | --------- | ---------------------------------------------------------------------------------- |
| `/internal/auth/status`                            | GET       | Returns `apiKeyConfigured` metadata without leaking the secret.                    |
| `/internal/runs/{runId}`                           | GET/PATCH | Fetch or update workflow run state (creates run on PATCH when `storyId` provided). |
| `/internal/prompts/{runId}/{chapterNumber}`        | GET       | Retrieves stored chapter illustration prompt from outline step.                    |
| `/internal/runs/{runId}/outline`                   | POST      | Stores outline JSON and refreshes progress tracking.                               |
| `/internal/runs/{runId}/chapter/{chapterNumber}`   | POST      | Persists generated chapter HTML and metadata.                                      |
| `/internal/prompts/{runId}/book-cover/{coverType}` | GET       | Returns front/back cover prompt from outline.                                      |
| `/internal/runs/{runId}/image`                     | POST      | Records generated image metadata and updates story/chapter URIs.                   |
| `/internal/stories/{storyId}`                      | GET       | Story metadata snapshot (title, language, feature flags).                          |
| `/internal/stories/{storyId}/html`                 | GET       | Raw chapter text (HTML stripped) for audiobook workflows.                          |
| `/internal/audiobook/chapter`                      | POST      | TTS generation without API key (used by Workflows).                                |
| `/internal/audiobook/finalize`                     | POST      | Marks audiobook completion and updates URIs.                                       |
| `/internal/stories/{storyId}/audiobook-status`     | PATCH     | Updates audiobook status (`generating`, `completed`, `failed`).                    |

### Print pipeline (`src/routes/print.ts`)

| Endpoint                                   | Auth    | Purpose                                                                                                                                                                                        |
| ------------------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /print/self-service`                 | API key | Public entry point the web app calls when a user requests a downloadable PDF bundle. Creates/updates the workflow run, dedupes recipients, and triggers the `print-generation` Cloud Workflow. |
| `POST /internal/print/generate`            | none    | Workflow callback that renders RGB + optional CMYK PDFs and uploads them to GCS.                                                                                                               |
| `POST /internal/print/self-service/notify` | none    | Workflow callback that emails download instructions (and signed PDF links) via the Notification Engine.                                                                                        |

#### `/print/self-service`

```json
{
  "storyId": "a3b7ac64-7715-4d9f-9c27-2b649c1a6f1d",
  "workflowId": "f233c186-3c19-4ee0-bd1b-132a775adbee", // optional; server auto-generates when omitted
  "recipientEmail": "reader@example.com", // optional shortcut for single recipient
  "recipients": [
    // optional array with name/locale metadata
    { "email": "reader@example.com", "name": "Avid Reader", "locale": "en-US" }
  ],
  "includeAuthorEmail": true, // defaults to true when authorEmail stored on story
  "ccEmails": ["librarian@example.com"],
  "locale": "en-US", // falls back to authorPreferredLocale or storyLanguage
  "generateCMYK": true,
  "metadata": { "requestSource": "webapp" }
}
```

- At least one deliverable recipient is required. The service adds the author automatically (unless `includeAuthorEmail: false`) and dedupes on lowercase email.
- The handler persists `delivery` metadata on the workflow run (`RunsService`) so follow-up hooks know whom to notify.
- Response shape:

```json
{
  "success": true,
  "message": "Self-print workflow started",
  "storyId": "...",
  "workflowId": "...",
  "executionId": "print-generation-123",
  "recipients": ["reader@example.com", "author@example.com"]
}
```

#### `/internal/print/generate`

```json
{
  "storyId": "c2f5...",
  "workflowId": "print-run-001",
  "generateCMYK": true
}
```

Returns storage URLs for RGB and CMYK PDFs (cover + interior). Ghostscript failures surface a `500` but partial uploads remain available in GCS.

#### `/internal/print/self-service/notify`

Workflow passes the run metadata alongside the uploaded assets so the Notification Engine can reach every requested recipient.

```json
{
  "storyId": "a3b7ac64-7715-4d9f-9c27-2b649c1a6f1d",
  "runId": "f233c186-3c19-4ee0-bd1b-132a775adbee",
  "delivery": {
    "recipients": [{ "email": "reader@example.com", "name": "Avid Reader" }],
    "locale": "en-US",
    "metadata": { "serviceCode": "selfPrinting" }
  },
  "printResult": {
    "interiorPdfUrl": "https://storage.googleapis.com/.../interior.pdf",
    "coverPdfUrl": "https://storage.googleapis.com/.../cover.pdf",
    "interiorCmykPdfUrl": "https://storage.googleapis.com/.../interior-cmyk.pdf",
    "coverCmykPdfUrl": null
  }
}
```

If no recipients remain (e.g., metadata stripped), the endpoint returns `200` with `reason: "no_recipients"` and logs a warning; otherwise it forwards the payload to `sendStoryPrintInstructionsEmail` and surfaces whether the notification service accepted the request.

## Debug endpoints (unauthenticated)

- `GET /debug/image` — Returns provider diagnostics (`model`, `usedVertex`, `timingMs`). Append `?image=true` to embed the generated JPEG as base64.
- `POST /debug/image` — Same metadata plus base64 image for a custom `prompt` in the JSON body.

## Error + safety semantics

All success payloads include `success: true`. Error payloads include `success: false`, `error`, and a `requestId` header for log correlation.

| HTTP status | Typical cause                                                        |
| ----------- | -------------------------------------------------------------------- |
| `400`       | Validation failure (missing storyId, invalid locale, etc.).          |
| `401`       | Missing or incorrect `x-api-key`.                                    |
| `404`       | Story/job/run not found or not linked to the requester.              |
| `409`       | Concurrent edits or conflicting workflow state.                      |
| `422`       | Safety systems blocked the prompt or request length exceeded limits. |
| `429`       | Upstream provider rate limits bubbled through the gateway.           |
| `500`       | Unexpected exception; see Cloud Run logs filtered by `requestId`.    |

Safety-blocked image requests always include extra metadata:

```json
{
  "success": false,
  "error": "SAFETY_BLOCKED: ...",
  "code": "IMAGE_SAFETY_BLOCKED",
  "promptRewriteAttempted": true,
  "fallbackAttempted": true
}
```

Need schemas or examples? Use `docs/openapi.yaml` (regenerated 2025‑11‑16) as the source of truth for request/response contracts.
