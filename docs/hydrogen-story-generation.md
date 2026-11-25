# Hydrogen story generation

Gemini text generation uses only `gemini-4-hydrogen`, with `@google/genai` and explicit Developer API `v1beta`. Image generation remains Nano Banana 2.1 and synthesis remains Gemini 3.8 Flash TTS. Narration direction and other Gemini text/vision helpers use Hydrogen. Older Gemini text request branches and explicit context caching have been removed. Historical model pricing entries remain accounting data.

## Routing and configuration

The outline is always generated first. `STORY_TEXT_GENERATION_MODE=hybrid` selects chapter-by-chapter generation only when the saved audience is in `STORY_SEQUENTIAL_AUDIENCES` and the accepted outline has at least `STORY_SEQUENTIAL_MIN_CHAPTERS` chapters. Defaults: `young_adult_15-17,adult_18+` and 8. Every other combination uses whole-story generation. `chapter_by_chapter` forces the sequential path as an operational rollback.

`STORY_WHOLE_MAX_OUTPUT_TOKENS=262144` and `STORY_CHAPTER_MAX_OUTPUT_TOKENS=131072` include thinking and visible output across the entire turn. These ceilings do not request long prose. The adapter counts prompt material and clamps output to the unified 1,048,576-token context minus input and 8,192 tokens of headroom. Developer API token counting rejects native system-instruction/tools fields; their serialized text and the output schema are included in the count request, with headroom for wire overhead. Output beyond 65,536 tokens requires continuation. Narrative work keeps high thinking; small helper tasks use their existing low/high settings. Sampling knobs, thinking budgets and explicit caching are absent.

Cloud Build preserves the existing audience list and routing configuration by default. The environment schema, manifest and local example share these settings. Invalid models, audiences, thresholds or budgets fail startup validation.

## Durable generation and contracts

Authenticated `POST /internal/runs/:runId/text/plan` snapshots the accepted outline, prompts, model and routing policy. `POST /internal/runs/:runId/text/advance` accepts `{ "chapterNumber": 1 }` and advances at most one provider segment. It returns `pending` or `completed`; completed receipts include `chapterId` and `version`. Workflows loops over compact receipts, never whole manuscripts.

The initial advance initializes the plan automatically. State is stored at `{storyId}/text/{runId}/checkpoint.enc`, referenced by the `text_generation_state` workflow step. AES-256-GCM encrypts manuscript, signed parts, immutable request and opaque continuation tokens before upload, including when the asset bucket has public image access. The key is derived from `STORY_GENERATION_WORKFLOW_API_KEY` using HKDF and the run ID; do not rotate the authentication secret until all active runs drain. Checkpoints must never be logged or exposed through a public API.

A database session advisory lock prevents concurrent advancement of a run. The lock remains held until the underlying provider operation settles. Each successful segment saves output parts, token, finish reason and usage before returning. Continuations resend the original request with its latest token; partial output is not appended to the request. Empty thinking-only segments can continue. Only STOP completes a turn. There is a 32-segment bound; each HTTP provider segment has a 20-minute timeout, and Workflows allows 30 minutes per advancement request.

Whole-story output is schema-constrained JSON with ordered `chapterNumber`/`htmlContent` entries. Exact chapter count, nonempty paragraphs, allowed HTML and existing baby/preschool paragraph limits are checked before persistence. Invalid or truncated final output switches once to sequential Hydrogen generation. Safety blocks remain blocked and are not switched to another story mode. Infrastructure failures are not treated as invalid prose.

Sequential requests include the outline, roster and every preceding completed chapter from the same run. Missing history fails explicitly; the service never substitutes an older generation's chapters or silently truncates context. Each new chapter is a new turn. A continuation token only resumes the current unfinished chapter.

Preallocated chapter IDs live in the checkpoint before core database inserts. Conflict-safe persistence and same-run workflow step receipts recover a crash between the two databases without creating another version. Existing `write_chapter_N` records, progress, chapter image ordering and successful run identity remain in use. Whole-story chapters are all committed before chapter images start.

A request left `requestPending` after a network/process failure has an unknown provider outcome. Automatic retries stop instead of guessing whether generation was billed. Inspect the failed run and provider logs, reconcile available usage, then use the existing authorized story restart process for a fresh run. Successful stored segments resume automatically. No exactly-once billing guarantee is possible when a provider response is lost before checkpointing.

## Usage and prices

Standard Hydrogen rates are USD 1.50/M input, 0.075/M cached input and 7.50/M output including thinking. Cached input is subtracted from regular input. Every successful segment is persisted with its own stable usage ID, including invalid whole-story drafts and segments before a later failure. Retried usage inserts are conflict-safe. Generic text middleware also sums segment observations and preserves measured partial usage on failures. Missing provider counts remain marked as estimates or unknown outcomes rather than claimed as measurements.

Whole-story generation uses action `chapter_writing`, operation `whole_story_writing`; sequential work uses operation `chapter_writing`. Metadata includes run ID, segment, mode, thinking tokens and measurement source. Existing Admin model grouping consumes these rows without new model registration. EUR costs retain the repository's approximate 0.92 USD-to-EUR conversion.

## Prompt review

Structure/outline schemas no longer request exposed `thought_process`. Prompts return only downstream story data; historical records with extra fields remain readable. The outline author role is audience-neutral. Chapter formatting is audience-appropriate. The initial adult whole-story evaluation compressed prose substantially; the v2 prompts therefore request roughly 1,500-2,000 words per teen/adult prose chapter, with explicit author length requests and concise genres taking precedence. This is guidance, not a guaranteed model length. The new whole-story prompt preserves author requests, characters, voice, locale, scene depth and a resolved final chapter. Safety rewrites retain their existing safety policy with low thinking and a bounded 2,048-token budget.

Translation prompts retain protected markup and locale contracts. Character/image analysis retains identity and localization requirements. Image, cover, print review, email-asset and narration templates retain their specialized output contracts; changing the text model does not change their business rules. Sequential requests put the stable outline/roster and growing prior-chapter history before the changing chapter task. Chapter identity stays in the user task rather than breaking the system-prefix cache. Stable instructions remain separate from changing story material; no prompt padding is added to obtain caching discounts.

## Validation and coordinated release

Run `npm run format`, `npm run lint`, `npm run typecheck`, `npm run build`, `npm test -- --runInBand`, `npm run env:validate`, and `npm run env:parity -- --strict-cloudbuild`. Tests use mocks/disposable resources; do not run production migrations or destructive fixtures. No migration is needed for this feature.

1. Save the current Cloud Run revision, workflow definition and routing configuration for rollback.
2. Commit the validated release. Run `scripts/deploy.ps1 -StoryTextGenerationMode chapter_by_chapter` from that clean commit to update Cloud Run with Hydrogen while retaining sequential routing.
3. Deploy `workflows/story-generation.yaml` explicitly with `gcloud.cmd workflows deploy`, preserving the existing service account, call-log level and Pub/Sub trigger. The Cloud Run deploy script intentionally does not deploy Workflows.
4. Verify the new workflow, then set `STORY_TEXT_GENERATION_MODE=hybrid`. Verify revision/SHA, traffic, health and model/routing configuration.
5. Smoke-test fictional whole-story and sequential runs, exact chapter identities, usage persistence and image/TTS SDK compatibility. Do not contact real customers.

Routing settings are snapshotted per run; a routing regression switch to `chapter_by_chapter` affects new runs, while active runs finish their saved plan. For a model/SDK regression, restore the previous workflow definition before restoring the prior Cloud Run revision; drain active executions first. Rollback uses immutable previous artifacts, never an older-model fallback in the new adapter.

Sources: [Hydrogen guide](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-hydrogen), [long decode](https://aistudio.google.com/docs/long-decode?generate-content=true), [pricing](https://aistudio.google.com/docs/pricing#gemini-4-hydrogen), [SDK changelog](https://github.com/googleapis/js-genai/blob/v3.3.0/CHANGELOG.md).

Measured fictional-case comparisons and their limitations are documented in [the evaluation report](hydrogen-evaluation.md).
