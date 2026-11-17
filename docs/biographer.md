# AI Biographer — Phase 1

Status: implementation behind disabled-by-default flags; project entitlement, region, voice dialect, commercial research rights and real-device tests are release gates.

## Services and trust

The normal SGW process exposes API-key-protected `POST /api/biographer/interview` and `/proposal`. The separate `npm run start:biographer-live` entrypoint listens at `/live` and only accepts explicitly allowed browser Origins. It uses Gemini **3.8 Live only**, Vertex/Cloud ADC, prebuilt avatar `Ben`, voice `Puck`, `VIDEO` output, native PCM16k input and input/output transcription. No Google credential is sent to the browser.

WebApp creates a 60-second one-use project/session ticket. The browser's first JSON message is `{type:"authenticate",ticket,projectId,sessionId}`. The gateway calls WebApp `/api/biographer/internal/admit` using `BIOGRAPHER_INTERNAL_API_KEY`; only after successful membership/consent/quota admission does it open Gemini. Authoritative leases are checked every 20 seconds; denial or service failure closes the call. This does not change authentication on existing SGW APIs.

Client messages: `audio` with base64 PCM and `turnId`; `text` with `text`/`turnId`; `end_audio`; `pause`. Server events: `ready`, `media` (`mimeType`,`data`), `transcript` (`role`,`turnId`,`text`,`final`), `turn_complete`, `interrupted`, `reconnecting`, `allowance`, `error`.

## Durability

Browser archival segments go directly to WebApp private storage; live audio delivery is independent. The gateway commits transcription updates through `/internal/checkpoint` before acknowledging them. Transcript status does not prove audio archival. Stable user turn IDs bind transcript to recordings. A failed checkpoint terminates live conversation rather than claiming a successful save. Original queued audio can recover transcription separately. GoAway closes with reconnect guidance; a new admission rehydrates persisted project history, rather than depending on a provider-only resumption cache.

## Book handoff

WebApp creates the paid story with `[MYTHORIA_BIOGRAPHER_V1]` in additional requests and an immutable generation snapshot. `/ai/text/outline` reads `/api/biographer/internal/snapshot` and returns exactly the approved titles/synopses. Chapter writing receives the cited **original source turns**, external research and frozen persona guidance. Missing sources fail closed. Photos are references only and must match the approved project/participant photos prefix. `BIOGRAPHER_STORAGE_BUCKET` must explicitly match the WebApp private bucket and the SGW identity requires read access. Missing or unreadable approved references fail the image job rather than silently dropping them. Every response is either mapped to a chapter or listed with an omission reason for creator review.

The new `contextual-storyteller` persona has fictionality1. Structure preserves an existing persona instead of overwriting it. Other selected personas retain creative freedom; recollections remain original data. No participant fiction is reintroduced into interview testimony.

## Research

Brave search is separate from live conversation. `BIOGRAPHER_RESEARCH_ENTITLEMENT_CONFIRMED=true` must only be set after entitlement for automated retrieval, retained evidence and commercial downstream use is verified. Third-party rights remain separate. Queries use **creator-confirmed public place/era labels only**, never private identities/transcripts. Missing place input, missing entitlement, failed search or no evidence blocks proposal; no fictitious research fallback. Google Search Grounding is not used to build permanent book evidence.

## Configuration and rollout

New keys are in `.env.schema.json` and `src/config/environment.ts`: `BIOGRAPHER_ENABLED`, `BIOGRAPHER_LIVE_ENABLED`, `BIOGRAPHER_WEBAPP_URL`, `BIOGRAPHER_STORAGE_BUCKET`, `BIOGRAPHER_INTERNAL_API_KEY`, `BIOGRAPHER_ALLOWED_ORIGINS`, `BIOGRAPHER_GOOGLE_LOCATION`, `BIOGRAPHER_AVATAR_NAME`, `BIOGRAPHER_VOICE_NAME`, `BIOGRAPHER_MAX_CONNECTIONS`, `BIOGRAPHER_RESEARCH_ENTITLEMENT_CONFIRMED`, `BRAVE_SEARCH_API_KEY`.

Deploy the same built SGW image as a **separate Cloud Run service** with command `node`, argument `dist/biographer-live.js`, exact allowed origin and Secret Manager binding for the internal key. Choose request timeout/concurrency/max-instances after a bounded pilot; Cloud Run sockets expire and clients reconnect. Enable ADC only for required model/storage access. Do not enable the normal SGW process for browser access, alter existing service IAM, apply migrations or switch flags as part of a code-only release. Prepare required WebApp additive migration on an isolated DB first.

Phase 2 collaboration is not enabled here. Main-author-only durable projects and participant IDs provide its foundation. Production acceptance still requires: exact EU avatar endpoint/entitlement, native European dialect tests, streaming MP4 browser playback, photo/reference consistency, measured modality billing, source deletion/cancellation, 20k-word narrative/ebook/audio/print checks, and operational refund/recovery validation.
