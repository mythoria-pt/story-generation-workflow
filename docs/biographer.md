# AI Biographer — Phase 1

Status: implementation behind disabled-by-default flags; project entitlement, region, voice dialect, and real-device tests are release gates.

## Services and trust

The normal SGW process exposes API-key-protected `POST /api/biographer/interview`, `/proposal`, `/transcribe`, and `/whisperer`. Story Whisperer submits saved turns and photo captions to `/whisperer` for readiness and, when requested, one follow-up question with optional choices. WebApp assembles the story seed from the author’s text. When those notes exceed the handoff length, `/whisperer/condense` accepts bounded chunks and returns a shorter seed that preserves author-provided details. The separate `npm run start:biographer-live` entrypoint listens at `/live` and only accepts explicitly allowed browser Origins. It uses Gemini **3.8 Live only**, Vertex/Cloud ADC, voice `Puck`, 24 kHz PCM audio output, 16 kHz PCM input and input/output transcription. No Google credential is sent to the browser.

WebApp creates a 60-second one-use project/session ticket. The browser's first JSON message is `{type:"authenticate",ticket,projectId,sessionId}`. The gateway calls WebApp `/api/biographer/internal/admit` using `BIOGRAPHER_INTERNAL_API_KEY`; only after successful membership/consent/quota admission does it open Gemini. Authoritative leases are checked every 20 seconds; denial or service failure closes the call. This does not change authentication on existing SGW APIs.

Client messages: `audio` with base64 PCM and `turnId`; `text` with `text`/`turnId`; `end_audio`; `pause`. Server events: `ready`, `media` (`mimeType`,`data`), `transcript` (`role`,`turnId`,`text`,`final`), `capture_boundary` (`turnId`, `nextTurnId`), `turn_complete`, `interrupted`, `reconnecting`, `allowance`, `error`.

## Durability

Browser archival segments go directly to WebApp private storage; live audio delivery is independent. The gateway commits transcription updates through `/internal/checkpoint` before acknowledging them. Transcript status does not prove audio archival. Stable user turn IDs bind transcript to recordings. A capture boundary rotates the recording ID immediately so another answer can begin while a checkpoint is in flight. A saved transcript event follows the database acknowledgement. A failed checkpoint terminates live conversation rather than claiming a successful save. Original queued audio can recover transcription separately for up to seven days. Dictation uses `/transcribe` independently and returns editable draft text before the author sends it to the interview. GoAway closes with reconnect guidance; a new admission rehydrates persisted project history, rather than depending on a provider-only resumption cache.

## Story Whisperer photo handoff

The WebApp stages selected interview photos in the private bucket as `{storyId}/inputs/whisperer-{structureRequestId}-{photoId}.{ext}`. The authenticated structure job must include the matching `storyWhisperer: true` and request ID. SGW analyzes them in private storage and writes the interview seed snapshot and metadata there. Cover rendering reads only private references scoped to the corresponding story. Private photos never pass through the ordinary relocation or character crop pipeline. The WebApp removes staged copies when it discards a handoff or deletes the story.

## Historical Biographer book handoff

WebApp creates the paid story with `[MYTHORIA_BIOGRAPHER_V1]` in additional requests and an immutable generation snapshot. `/ai/text/outline` reads `/api/biographer/internal/snapshot` and returns exactly the approved titles/synopses. Chapter writing receives the cited **original source turns**, any research retained in an already approved snapshot, and frozen persona guidance. Missing sources fail closed. Photos are references only and must match the approved project/participant photos prefix. `BIOGRAPHER_STORAGE_BUCKET` must explicitly match the WebApp private bucket and the SGW identity requires read access. Missing or unreadable approved references fail the image job rather than silently dropping them. Every response is either mapped to a chapter or listed with an omission reason for creator review.

The new `contextual-storyteller` persona has fictionality1. Structure preserves an existing persona instead of overwriting it. Other selected personas retain creative freedom; recollections remain original data. No participant fiction is reintroduced into interview testimony.

## Research

New proposals use saved memories and creator-provided context without external research and return an empty research array. A missing place does not block a proposal. The selected persona controls fictional treatment; invented historical facts and sources must not be presented as factual evidence. Previously approved snapshots retain their research evidence.

## Configuration and rollout

New keys are in `.env.schema.json` and `src/config/environment.ts`: `BIOGRAPHER_ENABLED`, `BIOGRAPHER_LIVE_ENABLED`, `BIOGRAPHER_WEBAPP_URL`, `BIOGRAPHER_STORAGE_BUCKET`, `BIOGRAPHER_INTERNAL_API_KEY`, `BIOGRAPHER_ALLOWED_ORIGINS`, `BIOGRAPHER_GOOGLE_LOCATION`, `BIOGRAPHER_VOICE_NAME`, `BIOGRAPHER_MAX_CONNECTIONS`.

Deploy the same built SGW image as a **separate Cloud Run service** with command `node`, argument `dist/biographer-live.js`, exact allowed origin and Secret Manager binding for the internal key. Choose request timeout/concurrency/max-instances after a bounded pilot; Cloud Run sockets expire and clients reconnect. Enable ADC only for required model/storage access. Do not enable the normal SGW process for browser access, alter existing service IAM, apply migrations or switch flags as part of a code-only release. Prepare required WebApp additive migration on an isolated DB first.

Story Whisperer submits a standard wizard structure job and uses regular book pricing. Before a pilot, test provider entitlement and voice quality in the deployment region, real-device PCM playback, private photo access, retention, and author-wide allowance enforcement. The historical book proposal APIs remain available for compatibility.
