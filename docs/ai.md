# AI & Prompt Operations

This guide consolidates how Story Generation Workflow talks to Google GenAI and OpenAI for text, image, and audio tasks, plus the guardrails that keep prompts safe and consistent.

## Provider strategy

| Concern           | Implementation                                                                                                                                                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime selection | `TEXT_PROVIDER` and `IMAGE_PROVIDER` environment variables toggle Google GenAI or OpenAI at runtime. The AI gateway (`src/ai/gateway.ts`) lazily instantiates providers and injects token tracking middleware.                                                                                                      |
| Image analysis    | The vision-language model used to analyse input images is selected by `IMAGE_ANALYZER_PROVIDER` (fallback `IMAGE_PROVIDER`, then `google-genai`) via `getImageAnalysisTextService` in `src/ai/gateway-with-tracking.ts`. OpenAI has no multimodal support yet, so an `openai` selection falls back to google-genai. |
| Models in use     | Google text and multimodal analysis use Gemini 4 Hydrogen. Google image generation and editing default to Nano Banana 2.1. Audiobook TTS defaults to Gemini `gemini-3.8-flash-tts` (`TTS_PROVIDER=google-genai`); OpenAI `gpt-4o-mini-tts` is the alternative provider. See `docs/audio-narration-system.md`.       |
| Context + state   | Prompt sessions are keyed by `<storyId>:<runId>`; `/ai/text/context/clear` must be called when workflows finish to avoid stale context bleed.                                                                                                                                                                       |
| Token telemetry   | Each AI call records an entry in `token_usage_tracking` with `action` (`outline`, `chapter`, `image`, `prompt_rewrite`, etc.) so we can budget costs or debug spikes.                                                                                                                                               |

## Gemini 4 Hydrogen text generation

Google text and multimodal analysis use `gemini-4-hydrogen` on the `v1beta` Developer API. The provider counts input tokens, clamps the requested output to the available context window, and joins explicit continuation segments. Use `thinkingConfig.thinkingLevel`, clear system instructions and a response schema for structured output.

The API-key-protected `POST /internal/runs/:runId/text/plan` returns the plan for an active generation run. `POST /internal/runs/:runId/text/advance` takes a positive integer `chapterNumber` and advances drafting or chapter persistence. The workflow repeats the call until it receives `status: completed`. Drafts, prompts and continuation tokens are encrypted in the storage checkpoint. When rolling a revision while runs are active, keep the same API key so the service can decrypt their checkpoints. The running Cloud Run image at `6c3de9b` contained the continuation implementation outside the available Git history. The restored implementation and `workflows/story-generation.yaml` correspond to the running image and deployed Workflow.

`STORY_TEXT_GENERATION_MODE` defaults to `hybrid`. In hybrid mode, chapter-by-chapter drafting applies when the story matches `STORY_SEQUENTIAL_AUDIENCES` and meets `STORY_SEQUENTIAL_MIN_CHAPTERS`. Set the mode to `chapter_by_chapter` to use sequential drafting for every run. `STORY_WHOLE_MAX_OUTPUT_TOKENS` and `STORY_CHAPTER_MAX_OUTPUT_TOKENS` control the requested generation budgets.

Google image generation and editing use the `interactions.create` API. The default image provider is `google-genai`. Set `IMAGE_PROVIDER=openai` to switch providers.

## Prompt templates

All templates live under `src/prompts/` and are rendered via `PromptService`. Key expectations:

### Chapter illustrations (`src/prompts/images/chapter.json`)

- Condensed (~120 words) XML-style structure containing `<task>`, `<scene>`, `<reference_images>`, `<negative_prompt>`.
- `{{#customInstructions}}` block injects user-provided guidance when present; removed entirely when empty so we never emit blank tags.
- Negative prompts cover text artifacts, watermarks, distorted anatomy, and blurry renders.

### Covers (`front_cover.json` & `back_cover.json`)

- Explicit `⚠️ IMPORTANT` instruction forbids rendering a physical book, spine, or 3D mock-up; we only want the flat artwork.
- Require leaving safe space for typography and aligning palettes between front/back when both prompts run in one workflow.
- Negative prompts also reject ISBN/barcode overlays and stray text.

### Outline + character briefs (`src/prompts/en-US/text-outline.json`)

- `<character_consistency_rules>` mandates every illustration prompt include age, hair, eye color, clothing, and distinctive features for each visible character. Examples show acceptable phrasing.
- `<prompt_structure_guidelines>` forces a four-part description (setting, characters, action, mood) to stabilize scene composition.

### Image analysis + structuring (`src/prompts/image-analysis.json`, `src/prompts/en-US/text-structure.json`)

- `image-analysis.json` (shared) instructs the model to return ONLY JSON matching `schemas/image-metadata.json`: `overallImageContent` (photo/drawing/text), a detailed `description`, full OCR `text`, and detected `characters[]` — each with a `box_2d` of `[ymin, xmin, ymax, xmax]` normalised to a 0–1000 grid. The result is persisted as `{input}.json` in GCS and reused on later runs.
- `text-structure.json` consumes that metadata via `{{imageMetadata}}`: it personalises the story, links a character to its source photo through `sourceImagePath` + `sourceCharacterIndex` (used to crop the real photo with `sharp` into a character photo), and lists cover-relevant photos in `story.coverReferenceImages` / `backCoverReferenceImages`. Image bytes are never sent to the structuring model — only the extracted metadata text (plus audio, when present).

### Image editing prompts

- `buildImageEditPrompt()` (in `src/utils/imageUtils.ts`) rewrites user edit requests into "Generate a new image, taking as basis the image in attach, but..." instructions, appending style data from `imageStyles.json`.
- Routes now download the existing asset from GCS (`downloadFileAsBuffer`) and call the provider `edit()` API so style + composition carry over.

### Graphical-style contract

- `src/prompts/imageStyles.json` is the canonical prompt catalogue for graphical media. It contains the complete medium, material, lighting, consistency, and print-legibility guidance for every supported style, including `claymation` and `papercut`.
- `PromptService.buildImageGenerationPrompt()` combines the cover/chapter template with the selected style before the request reaches a provider. Google GenAI and OpenAI therefore receive the same system instruction.
- `/ai/image` reads `graphicalStyle` from the persisted story. Every normal, rewritten, fallback, and transient-retry prompt is rebuilt through the same composer so safety handling cannot silently lose the selected style.
- The allowed values in `imageStyles.json`, `src/prompts/schemas/story-structure.json`, and the read-only Drizzle enum mirror must remain in exact parity; `src/tests/image-style-contract.test.ts` enforces this contract.

### Dimensions + environment controls

```
IMAGE_DEFAULT_WIDTH=1024
IMAGE_DEFAULT_HEIGHT=1536
IMAGE_CHAPTER_WIDTH=1024
IMAGE_CHAPTER_HEIGHT=1536
IMAGE_COVER_WIDTH=1024
IMAGE_COVER_HEIGHT=1536
```

`getImageDimensions()` centralizes these values, keeping portrait output consistent across generate + edit flows. Update `.env.local` and `cloudbuild.yaml` when sizes change.

## Safety + retry strategy

| Layer            | Behavior                                                                                                                                                                                                                                                                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow retries | `workflows/story-generation.yaml` makes at most **2** requests per image, with a **60s** delay before another request for connection errors, HTTP 408/422/429, or 5xx. A 422 can reflect a transient failure during in-process safety recovery. Missing optional images are skipped. Chapter image requests returning 400, 404, or 409 stop the run. |
| Prompt rewrite   | `/ai/image` handles provider safety blocks by using `src/prompts/en-US/image-prompt-safety-rewrite.json` and attempting a safer prompt. A sanitized fallback is available if the rewrite fails. Private image responses omit the prompts and errors from these recovery attempts.                                                                    |
| Status codes     | The image endpoint returns 422 when safety recovery fails. A blocked optional image is skipped and the rest of the story can still complete. The image endpoint returns 500 on other generation failures once its own retries are exhausted.                                                                                                         |
| Token tagging    | Prompt rewrites log `action = 'prompt_rewrite'`, model used, and token counts so we can monitor rewrite frequency.                                                                                                                                                                                                                                   |

### Monitoring & debugging

- **Logs**: Find the image request, provider attempts, transient retries and outcome under the same `imageRequestId`. Use the run ID and image slot to compare separate HTTP requests. These events carry counts and status without logging prompts or asset URLs.
- **DB**: `SELECT status, current_step, error_message FROM story_generation_runs ORDER BY created_at DESC LIMIT 20;` confirms whether runs are `blocked` vs `failed`.
- **Token usage**: `SELECT story_id, ai_model, action, input_tokens, output_tokens FROM token_usage_tracking WHERE action = 'prompt_rewrite' ORDER BY created_at DESC LIMIT 50;` quantifies rewrite load.

### Testing checklist

1. **Safety block drill** – Mock a provider safety block for the original, rewritten and fallback prompts. Verify the endpoint returns 422 with `promptRewriteAttempted: true` and the workflow skips the optional image.
2. **Transient retry** – Mock a 503. Verify the image service applies its brief in-process retry and Workflows waits 60 seconds before its second request. The workflow can continue immediately if that request also fails.
3. **Custom instructions** – Store `imageGenerationInstructions` on a story, generate images, and confirm prompts include the block plus logs show `hasCustomInstructions: true` in `workflows/handlers` output.
4. **Image edit regression** – Run `/api/jobs/image-edit` against an existing chapter image and confirm the provider receives the original asset buffer (seen in debug logs) and new filename increments `_v00n`.
5. **Cover title on edit** – Front-cover edits (`/api/jobs/image-edit`) always instruct the model to keep or letter the exact story title (read from the DB, never from the request) via a `<title_lettering>` block in `buildImageEditPrompt`. The title is also made an explicit requested change: `buildCoverTitleRequest` appends `Letter the exact book title "<t>" on the cover, in the top third.` inside `<edit_request>`. In `processFrontCoverEdit` the final prompt ends with `Final requirement: the cover shows the title "<t>" lettered exactly as written in the top third.` (after the reference anchor and structured description, which then allows "the cover title lettering"), and `buildCoverTitleSystemPrompt` is passed as `systemPrompt` (Google `system_instruction`; OpenAI `generate()` uses it instead of its template system message, OpenAI `edit()` ignores it). Front-cover style conversion (`convertToStyle`) always uses `generate()` with the reference image, never `edit()`. `ImageGenerationMiddleware.supportsEdit()` reports whether the wrapped provider really implements `edit()`, so the worker no longer logs a spurious "does not support editing" error. Back cover and chapter edits pass no title and stay text-free (`No text overlays or watermarks.`).

## Backlog signals

- Style-specific exclusions currently live inside each style's `systemPrompt`. Introduce a separate `negativePrompt` field only if a future provider requires negative prompts as a distinct API parameter.
- Provider fallback (auto-switch OpenAI ↔ Google for blocked prompts) is not implemented—document manual playbooks before attempting.
- Prompt analytics dashboard could be layered on top of `token_usage_tracking` plus Cloud Logging to visualize block rates per story genre.
