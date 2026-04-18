# AI & Prompt Operations

This guide consolidates how Story Generation Workflow talks to Google GenAI and OpenAI for text, image, and audio tasks, plus the guardrails that keep prompts safe and consistent.

## Provider strategy

| Concern           | Implementation                                                                                                                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime selection | `TEXT_PROVIDER` and `IMAGE_PROVIDER` environment variables toggle Google GenAI or OpenAI at runtime. The AI gateway (`src/ai/gateway.ts`) lazily instantiates providers and injects token tracking middleware. |
| Models in use     | Text defaults to Gemini 2.5 Flash or GPT‑4.1 depending on provider; images stream through Imagen 4.0 Ultra or DALL·E 3; TTS leverages OpenAI voices (e.g., `coral`).                                           |
| Context + state   | Prompt sessions are keyed by `<storyId>:<runId>`; `/ai/text/context/clear` must be called when workflows finish to avoid stale context bleed.                                                                  |
| Token telemetry   | Each AI call records an entry in `token_usage_tracking` with `action` (`outline`, `chapter`, `image`, `prompt_rewrite`, etc.) so we can budget costs or debug spikes.                                          |

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

### Image editing prompts

- `buildImageEditPrompt()` (in `src/utils/imageUtils.ts`) rewrites user edit requests into "Generate a new image, taking as basis the image in attach, but..." instructions, appending style data from `imageStyles.json`.
- Routes now download the existing asset from GCS (`downloadFileAsBuffer`) and call the provider `edit()` API so style + composition carry over.

### Dimensions + environment controls

```
IMAGE_DEFAULT_WIDTH=1024
IMAGE_DEFAULT_HEIGHT=1536
IMAGE_CHAPTER_WIDTH=1024
IMAGE_CHAPTER_HEIGHT=1536
IMAGE_COVER_WIDTH=1024
IMAGE_COVER_HEIGHT=1536
```

`getImageDimensions()` centralizes these values, keeping portrait output consistent across generate + edit flows. Update `.env*` and `cloudbuild.yaml` when sizes change.

## Safety + retry strategy

| Layer            | Behavior                                                                                                                                                                                                                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow retries | `workflows/story-generation.yaml` retries each image up to **3** times with a **60s** delay for transient HTTP 500/503/429/timeouts. Non-retryable errors (400s, auth) bubble immediately.                                                                                                                       |
| Prompt rewrite   | `/ai/image` traps 422 or `moderation_blocked` responses, runs `src/prompts/en-US/image-prompt-safety-rewrite.json` through Google GenAI, and retries once with the safer prompt. Metadata (`promptRewriteAttempted`, `rewrittenPrompt`) is returned so workflows can mark runs as `blocked` instead of `failed`. |
| Status codes     | 422 indicates a definitive safety block after rewrite; workflows set `story_generation_runs.status = 'blocked'`. Exhausted retries return 500 and mark runs `failed`.                                                                                                                                            |
| Token tagging    | Prompt rewrites log `action = 'prompt_rewrite'`, model used, and token counts so we can monitor rewrite frequency.                                                                                                                                                                                               |

### Monitoring & debugging

- **Logs**: `pwsh -NoProfile -Command "npm run logs -- --filter promptRewriteAttempted"` highlights safety retries; `... --filter retryableError` surfaces transient failures.
- **DB**: `SELECT status, current_step, error_message FROM story_generation_runs ORDER BY created_at DESC LIMIT 20;` confirms whether runs are `blocked` vs `failed`.
- **Token usage**: `SELECT story_id, ai_model, action, input_tokens, output_tokens FROM token_usage_tracking WHERE action = 'prompt_rewrite' ORDER BY created_at DESC LIMIT 50;` quantifies rewrite load.

### Testing checklist

1. **Safety block drill** – Submit an intentionally sensitive cover prompt. Expect: first call 422, rewrite attempt logged, final response 422 with `promptRewriteAttempted: true`, run marked `blocked` not `failed`.
2. **Transient retry** – Temporarily deny outbound network or mock a 503. Expect: three attempts logged with 60s sleeps before failure.
3. **Custom instructions** – Store `imageGenerationInstructions` on a story, generate images, and confirm prompts include the block plus logs show `hasCustomInstructions: true` in `workflows/handlers` output.
4. **Image edit regression** – Run `/api/jobs/image-edit` against an existing chapter image and confirm the provider receives the original asset buffer (seen in debug logs) and new filename increments `_v00n`.

## Backlog signals

- Art-style negative prompts live only in base templates; extending `imageStyles.json` with per-style `negativePrompt` entries would reduce manual prompt hacking.
- Provider fallback (auto-switch OpenAI ↔ Google for blocked prompts) is not implemented—document manual playbooks before attempting.
- Prompt analytics dashboard could be layered on top of `token_usage_tracking` plus Cloud Logging to visualize block rates per story genre.
