# AI Biographer — Phase 1

Status: implementation behind disabled-by-default flags; project entitlement, region, voice dialect, and real-device tests are release gates.

## Services and trust

The normal SGW process exposes API-key-protected `POST /api/biographer/interview`, `/proposal`, `/transcribe`, and `/whisperer`. Story Whisperer submits saved turns and photo captions to `/whisperer` for readiness and, when requested, one follow-up question with optional choices. WebApp assembles the story seed from the author’s text. When those notes exceed the handoff length, `/whisperer/condense` accepts bounded chunks and returns a shorter seed that preserves author-provided details. The separate `npm run start:biographer-live` entrypoint listens at `/live` and only accepts explicitly allowed browser Origins. It uses Gemini **3.8 Live only**, Vertex/Cloud ADC, voice `Puck`, 24 kHz PCM audio output, 16 kHz PCM input and input/output transcription. No Google credential is sent to the browser.

Story Whisperer text requests may include `context.primaryIntent` and `context.opening` (a question and an array of zero or more answer suggestions) alongside the real history. The same fields are accepted in live admission. When the opening or a subsequent unanswered question is already on screen, the live session waits for the author’s audio. When the latest saved turn is the author’s answer, voice asks a new follow-up. The server stamps these assessments with `readiness.rubricVersion: 3`. Readiness needs a focal person or group with a usable distinguishing detail, a place or period, and a concrete scene, event or change. An alias, role or relationship can identify an anonymous subject. A name and a broad theme still leave details to explore. The author can explicitly delegate creative decisions that cover a missing detail. Text and voice follow the author’s latest direction, even when it shifts from the opening genre, and ask one direct book-planning question at a time. For a team story, the guide can ask which players to follow, what makes each recognizable, where they play and in what season. When the author wants a plot or has only a theme, it can suggest alternatives such as a match per chapter or interwoven player stories. A suggested cup run or ending becomes part of the book only if the author adopts it, with fictional choices kept distinct from recollections.

The condense endpoint accepts strings for standalone author notes and objects `{ question?: string, choices?: string[], text: string }` for answers that depend on an interviewer prompt. The question field can contain up to 1,200 characters, up to six choices of 250 characters each and an answer up to 40,000, within the existing 60,000-character combined budget. The story structure seed uses `interviewerQuestion`, optional ordered `interviewerChoices`, and `authorReply` labels. A reply such as “the second” adopts only the second option associated with that question. Assistant suggestions count as evidence only after explicit adoption by the author. Keep uncertainty and creative choices distinct from remembered details.

WebApp creates a 60-second one-use project/session ticket. The browser's first JSON message is `{type:"authenticate",ticket,projectId,sessionId}`. The gateway calls WebApp `/api/biographer/internal/admit` using `BIOGRAPHER_INTERNAL_API_KEY`; only after successful membership/consent/quota admission does it open Gemini. Authoritative leases are checked every 20 seconds; denial or service failure closes the call. This does not change authentication on existing SGW APIs.

Client messages: `audio` with base64 PCM and `turnId`; `text` with `text`/`turnId`; `end_audio`; `pause`; Story Whisperer `cancel`. Server events: `ready`, `media` (`mimeType`,`data`), `transcript` (`role`,`turnId`,`text`,`final`), `capture_boundary` (`turnId`, `nextTurnId`), `turn_complete`, `interrupted`, `reconnecting`, `allowance`, `error`.

On explicit Story Whisperer cancellation, the gateway closes Gemini immediately and stops accepting provider events. It drains the existing checkpoint queue and releases the lease with `action: 'discard'` and the current unfinished turn IDs so WebApp can discard them while preserving completed turns. An unexpected disconnect preserves committed text, including partial text the author can complete or discard.

## Text model

The Story Whisperer interview, readiness assessment, and seed condensation use `gemini-4-hydrogen` with low thinking. The outline created from the interview uses the same model with high thinking. Both local development and the deployed workflow select the model in code. The workflow uses its existing `GOOGLE_GENAI_API_KEY` binding. The live gateway uses Gemini 3.8 Live for the voice conversation.

Story Whisperer shares its interview instructions across text and live audio. Start with one direct question on the most consequential missing character, setting or plot detail. Move to another area once a topic has supplied a useful detail, unless the author wants to stay there. Ground pivots in facts supplied or adopted by the author. In European Portuguese, new questions and hints address the person as “tu”, including when resuming a chat with older formal replies. The book’s narrative point of view remains a separate editorial choice.

## Durability

Story Whisperer streams microphone frames to Gemini without retaining a recording. The gateway commits partial and final transcription updates through `/internal/checkpoint` before acknowledging them. The provider's input transcription completion is independent of model turn completion. Stable turn IDs keep late transcript text attached to its original answer. A capture boundary rotates the ID after provider input completion, while acknowledgement follows the durable WebApp checkpoint. A failed checkpoint closes the session for recovery from saved text. Old stored audio follows the WebApp's existing retention policy. Dictation uses `/transcribe` independently and returns editable draft text before the author sends it to the interview. GoAway closes with reconnect guidance and a new admission rehydrates persisted history.

## Story Whisperer live outline handoff

Only Story Whisperer voice registers the Gemini Live `advance_to_outline` function. It requests an outline when the latest author turn explicitly asks to advance. The gateway sends `advance_to_outline` with `callId` and `turnId` after saving that turn’s final transcript. WebApp checks readiness and persists its own outline handoff before replying `advance_to_outline_result` with the matching `callId` and boolean `accepted`. The gateway relays the result to Gemini. Provider cancellation or result timeout sends `advance_to_outline_cancelled` with `callId`. An interrupted, stale, or rejected request can be followed by a fresh author turn.

For either a voice request or a click, WebApp freezes capture and sends `prepare_outline` with a UUID `requestId`. The gateway ends the audio stream and waits for pending transcript checkpoints before sending `outline_prepared` with the same ID. It gives silent frames 1.8 seconds to drain and frames that may be background noise up to 4 seconds for Gemini to signal speech. Confirmed speech or transcript text continues through transcript finalization. A speech turn with a missing final transcript has a bounded recovery deadline after the provider reports speech end or the audio stream is ended. The gateway emits `speech_detected` so the WebApp can distinguish a lost reply from silence. The gateway suppresses further assistant playback and checkpoints while the outline handoff is prepared. On rejection WebApp sends `resume_outline` and resumes capture. On success it can pause the interview.

## Story Whisperer photo handoff

The WebApp stages selected interview photos in the private bucket as `{storyId}/inputs/whisperer-{structureRequestId}-{photoId}.{ext}`. The authenticated structure job must include the matching `storyWhisperer: true` and request ID. SGW analyzes them in private storage and writes the interview seed snapshot and metadata there. Cover rendering reads only private references scoped to the corresponding story. Private photos never pass through the ordinary relocation or character crop pipeline. The WebApp removes staged copies when it discards a handoff or deletes the story.

## Historical Biographer book handoff

WebApp creates the paid story with `[MYTHORIA_BIOGRAPHER_V1]` in additional requests and an immutable generation snapshot. `/ai/text/outline` reads `/api/biographer/internal/snapshot` and returns exactly the approved titles/synopses. Chapter writing receives the cited **original source turns**, any research retained in an already approved snapshot, and frozen persona guidance. Missing sources fail closed. Photos are references only and must match the approved project/participant photos prefix. `BIOGRAPHER_STORAGE_BUCKET` must explicitly match the WebApp private bucket and the SGW identity requires read access. Missing or unreadable approved references fail the image job rather than silently dropping them. Every response is either mapped to a chapter or listed with an omission reason for creator review.

The new `contextual-storyteller` persona has fictionality1. Structure preserves an existing persona instead of overwriting it. Other selected personas retain creative freedom; recollections remain original data. No participant fiction is reintroduced into interview testimony.

## Research

New proposals use saved memories and creator-provided context without external research and return an empty research array. A missing place does not block a proposal. The selected persona controls fictional treatment; invented historical facts and sources must not be presented as factual evidence. Previously approved snapshots retain their research evidence.

## Configuration and rollout

New keys are in `.env.schema.json` and `src/config/environment.ts`: `BIOGRAPHER_ENABLED`, `BIOGRAPHER_LIVE_ENABLED`, `BIOGRAPHER_WEBAPP_URL`, `BIOGRAPHER_STORAGE_BUCKET`, `BIOGRAPHER_INTERNAL_API_KEY`, `BIOGRAPHER_ALLOWED_ORIGINS`, `BIOGRAPHER_GOOGLE_LOCATION`, `BIOGRAPHER_VOICE_NAME`, `BIOGRAPHER_MAX_CONNECTIONS`.

### Private gateway staging

The dedicated `biographer-live` service runs the approved SGW image digest in `europe-west9` with the entrypoint `node dist/biographer-live.js`. Keep the Cloud Run Invoker IAM check enabled and restrict invocation to authorized identities during staging. The manifest preserves the existing invoker policy on redeploy. Verify that policy before and after deploying. Private staging does not establish end-to-end browser, audio or Vertex readiness.

The gateway logger is independent of the main SGW environment schema. Its startup check must pass without SQL credentials or the main SGW storage configuration. The gateway sends transcript and lease updates through the authenticated WebApp callbacks.

On 2026-11-23, Cloud Run revision `biographer-live-00002-mcm` was staged privately at `https://biographer-live-x2qrlilyyq-od.a.run.app`. It uses the corrected image `gcr.io/oceanic-beach-460916-n5/story-generation-workflow@sha256:e0367adcb855d3a8a36d62208adc8f3ebec9ac2cf36327d8df52301fe87328a6` from build `f023f038-626b-4bf8-bbae-65236889c78d`. The image overlays the compiled gateway logger fix from `2d5f9bf` on the image built from `1afc824`. Future builds can compile the fixed source with the standard SGW Dockerfile. The private smoke test returned HTTP 403 without an identity and HTTP 200 with an authorized identity. With that identity the WebSocket handshake returned 101 for `https://mythoria.pt` and 401 for an unlisted origin. An admitted Gemini session and transcript persistence remain pilot checks.

| Setting                 | Production staging value                                                                                                                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Billing and capacity    | Request-based billing, 0 minimum and 5 maximum instances, 10 concurrent requests and 10 sockets per instance. An open socket keeps a request active.                                                 |
| Transport               | HTTP/1 WebSocket upgrade on `/live`, container port 8080, 3,600-second request timeout. Clients reconnect after disconnection.                                                                       |
| Runtime identity        | `biographer-live@oceanic-beach-460916-n5.iam.gserviceaccount.com`                                                                                                                                    |
| Vertex access           | Project custom role `mythoriaBiographerLivePredict`, containing only `aiplatform.endpoints.predict`. The gateway requests `gemini-3.8-live` in `eu` using ADC.                                       |
| WebApp callbacks        | Set `BIOGRAPHER_WEBAPP_URL` to the existing WebApp HTTPS `run.app` service URL. Set `BIOGRAPHER_ALLOWED_ORIGINS` to the exact pilot browser origin on both the WebApp and gateway.                   |
| Callback authentication | Bind `BIOGRAPHER_INTERNAL_API_KEY` to Secret Manager version `1`. Grant the gateway identity secret accessor on this secret. Configure the same version on the WebApp for admission and checkpoints. |

Story Whisperer photos and historical recovery audio use authenticated WebApp endpoints and the private bucket. SGW needs access to read private inputs and write staged story artifacts. These server-side requests require no browser CORS change on the bucket. The gateway uses Vertex and WebApp callbacks.

The normal SGW deployment and the gateway deployment are separate Cloud Run releases. Build a new SGW image when updating code, and use its digest to roll the gateway separately. For an existing gateway whose configuration already matches the table, deploy the image alone to preserve every runtime binding, capacity setting and invoker grant:

```sh
gcloud run services update biographer-live --project=oceanic-beach-460916-n5 \
  --region=europe-west9 --image="$SGW_IMAGE_DIGEST"
```

For initial provisioning or an approved full configuration rollout, set `SGW_IMAGE_DIGEST` to the approved fully qualified image reference including `@sha256:…`, `WEBAPP_URL` to the WebApp Cloud Run service URL, and `WEBAPP_ORIGIN` to the public-facing HTTPS origin. Run from the SGW checkout. The build deploys the existing image without uploading source.

```sh
gcloud builds submit --no-source --config=cloudbuild.biographer.yaml \
  --project=oceanic-beach-460916-n5 \
  --substitutions="_IMAGE=${SGW_IMAGE_DIGEST},_SERVICE_ACCOUNT=biographer-live@oceanic-beach-460916-n5.iam.gserviceaccount.com,_WEBAPP_URL=${WEBAPP_URL},_WEBAPP_ORIGIN=${WEBAPP_ORIGIN},_INTERNAL_KEY_SECRET=BIOGRAPHER_INTERNAL_API_KEY,_INTERNAL_KEY_VERSION=1"
```

### Pilot activation and rollback

1. Keep public admission disabled in the WebApp. Verify the WebApp-owned schema and runtime grants, and drain any legacy live leases before cutover. Deploy the normal SGW assessment endpoint before the matching WebApp revision.
2. Configure the WebApp gateway URL as `wss://<gateway-host>/live`. The gateway process needs `BIOGRAPHER_LIVE_ENABLED=true` to start even in private staging. Verify private Cloud Run invocation, the allowed origin, the shared callback key and Vertex entitlement in `eu`.
3. Keep the recovery-audio Scheduler job paused during staging. Follow the WebApp retention runbook to verify its OIDC audience, storage permissions and cleanup behavior before enabling the schedule. The cleanup endpoint can delete expired audio while public admission is disabled.
4. The WebApp currently gates Step 2 with the service-wide `BIOGRAPHER_ENABLED` flag. Use a restricted pilot deployment or an equivalent verified audience control before enabling it for a limited cohort. Enable the normal SGW assessment endpoints and verify the SGW runtime identity can invoke Vertex for editable dictation. For the approved pilot, open browser invocation on the dedicated gateway, retain application-level origin and ticket checks, and enable the WebApp pilot configuration. Verify a real-device voice turn, transcript checkpoint, reconnect, allowance enforcement and expiration for historical audio. On an otherwise idle instance, test cancellation and forced disconnection of the last socket. Check that completed turns and recoverable partial text stay saved, no live recording is retained, and the voice allowance settles correctly. With request-based billing, work scheduled after the last request can be suspended.
5. To roll back, disable new WebApp admissions first and allow existing sockets to drain. Restore private gateway invocation if ending the pilot. If a revision introduced the issue, direct gateway traffic back to the last approved image revision and verify its secret version remains available. Keep retention operating for captured audio unless the cleanup job itself requires rollback.

Story Whisperer submits a standard wizard structure job and uses regular book pricing. Before a pilot, test provider entitlement and voice quality in the deployment region, real-device PCM playback, private photo access, retention, and author-wide allowance enforcement. The historical book proposal APIs remain available for compatibility.
