# AI Biographer — Phase 1

Status: implementation behind disabled-by-default flags; project entitlement, region, voice dialect, and real-device tests are release gates.

## Services and trust

The normal SGW process exposes API-key-protected `POST /api/biographer/interview`, `/proposal`, `/transcribe`, and `/whisperer`. Story Whisperer submits saved turns and photo captions to `/whisperer` for readiness and, when requested, one follow-up question with optional choices. WebApp assembles the story seed from the author’s text. When those notes exceed the handoff length, `/whisperer/condense` accepts bounded chunks and returns a shorter seed that preserves author-provided details. The separate `npm run start:biographer-live` entrypoint listens at `/live` and only accepts explicitly allowed browser Origins. It uses Gemini **3.8 Live only**, Vertex/Cloud ADC, voice `Puck`, 24 kHz PCM audio output, 16 kHz PCM input and input/output transcription. No Google credential is sent to the browser.

Story Whisperer text requests may include `context.primaryIntent` and `context.opening` (a question and an array of zero or more answer suggestions) alongside the real history. The same fields are accepted in live admission. When the opening or a subsequent unanswered question is already on screen, the live session waits for the author’s audio. When the latest saved turn is the author’s answer, voice asks a new follow-up. The server stamps these assessments with `readiness.rubricVersion: 3`. Readiness needs a focal person or group with a usable distinguishing detail, a place or period, and a concrete scene, event or change. An alias, role or relationship can identify an anonymous subject. A name and a broad theme still leave details to explore. The author can explicitly delegate creative decisions that cover a missing detail. Text and voice follow the author’s latest direction, even when it shifts from the opening genre, and use themes such as team spirit to invite a specific moment.

The condense endpoint accepts strings for standalone author notes and objects `{ question?: string, choices?: string[], text: string }` for answers that depend on an interviewer prompt. The question field can contain up to 1,200 characters, up to six choices of 250 characters each and an answer up to 40,000, within the existing 60,000-character combined budget. The story structure seed uses `interviewerQuestion`, optional ordered `interviewerChoices`, and `authorReply` labels. A reply such as “the second” adopts only the second option associated with that question. Assistant suggestions count as evidence only after explicit adoption by the author. Keep uncertainty and creative choices distinct from remembered details.

WebApp creates a 60-second one-use project/session ticket. The browser's first JSON message is `{type:"authenticate",ticket,projectId,sessionId}`. The gateway calls WebApp `/api/biographer/internal/admit` using `BIOGRAPHER_INTERNAL_API_KEY`; only after successful membership/consent/quota admission does it open Gemini. Authoritative leases are checked every 20 seconds; denial or service failure closes the call. This does not change authentication on existing SGW APIs.

Client messages: `audio` with base64 PCM and `turnId`; `text` with `text`/`turnId`; `end_audio`; `pause`; Story Whisperer `cancel`. Server events: `ready`, `media` (`mimeType`,`data`), `transcript` (`role`,`turnId`,`text`,`final`), `capture_boundary` (`turnId`, `nextTurnId`), `turn_complete`, `interrupted`, `reconnecting`, `allowance`, `error`.

On explicit Story Whisperer cancellation, the gateway closes Gemini immediately and stops accepting provider events. It drains the existing checkpoint queue and releases the lease with `action: 'discard'` and the current unfinished turn IDs so WebApp can discard them while preserving completed turns. A pause or unexpected disconnect retains the existing recovery flow.

## Text model

The Story Whisperer interview, readiness assessment, and seed condensation use `gemini-4-hydrogen` with low thinking. The outline created from the interview uses the same model with high thinking. Both local development and the deployed workflow select the model in code. The workflow uses its existing `GOOGLE_GENAI_API_KEY` binding. The live gateway uses Gemini 3.8 Live for the voice conversation.

Story Whisperer shares its interview voice across text and live audio. In European Portuguese, new questions and hints address the person as “tu”, including when resuming a chat with older formal replies. Ask about the author’s own experience when they lived or witnessed the scene. The book’s narrative point of view remains a separate editorial choice.

## Durability

Browser archival segments go directly to WebApp private storage; live audio delivery is independent. The gateway commits transcription updates through `/internal/checkpoint` before acknowledging them. Transcript status does not prove audio archival. Stable user turn IDs bind transcript to recordings. A capture boundary rotates the recording ID immediately so another answer can begin while a checkpoint is in flight. A saved transcript event follows the database acknowledgement. A failed checkpoint terminates live conversation rather than claiming a successful save. Original queued audio can recover transcription separately for up to seven days. Dictation uses `/transcribe` independently and returns editable draft text before the author sends it to the interview. GoAway closes with reconnect guidance; a new admission rehydrates persisted project history, rather than depending on a provider-only resumption cache.

## Story Whisperer live outline handoff

Only Story Whisperer voice registers the Gemini Live `advance_to_outline` function. It requests an outline when the latest author turn explicitly asks to advance. The gateway sends `advance_to_outline` with `callId` and `turnId` after saving that turn’s final transcript. WebApp checks readiness and persists its own outline handoff before replying `advance_to_outline_result` with the matching `callId` and boolean `accepted`. The gateway relays the result to Gemini. Provider cancellation or result timeout sends `advance_to_outline_cancelled` with `callId`. An interrupted, stale, or rejected request can be followed by a fresh author turn.

For either a voice request or a click, WebApp freezes capture and sends `prepare_outline` with a UUID `requestId`. The gateway ends the audio stream and waits for pending transcript checkpoints before sending `outline_prepared` with the same ID. When Gemini receives only silence at the end of continuous capture, it may omit a final event, so the gateway gives untranscribed trailing frames a short drain window and acknowledges a silent tail only if it has no transcript, no Gemini speech-start signal and all PCM frames are below the browser archival threshold. When Gemini reports speech or returns the first nonblank transcript, the gateway also emits `speech_detected` with the turn ID so WebApp can archive low-level input. WebApp waits for source audio archival. The gateway suppresses further assistant playback and checkpoints while the outline handoff is prepared. On rejection WebApp sends `resume_outline` and resumes capture. On success it can pause the interview.

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
