# Audio Narration System - Complete Technical Documentation

## Overview

The Mythoria audio narration system transforms written story chapters into spoken audio using AI-powered Text-to-Speech (TTS). The system spans two services: **mythoria-webapp** (voice selection and orchestration) and **story-generation-workflow** (audio generation engine).

The default provider is **Google Gemini TTS** with the single supported model `gemini-3.8-flash-tts`. **OpenAI** (`gpt-4o-mini-tts`) remains available as an alternative provider.

The system also supports **optional background music mixing**, which automatically selects ambient music based on the story's target audience and genre, then mixes it with the narration at a configurable volume level.

---

## Architecture Flow

```
+---------------------------------------------------------------------------------+
|                              MYTHORIA-WEBAPP                                    |
|  +---------------------+    +----------------------+    +-------------------+   |
|  |  Voice Selection    |--->|  AudiobookGeneration |--->|  Server Action    |   |
|  |  + Background Music |    |  Trigger Component   |    |  generateAudiobook|   |
|  +---------------------+    +----------------------+    +---------+---------+   |
+--------------------------------------------------------------------|-----------+
                                                                     |
                                                   HTTP POST /api/stories/{id}/audio
                                                                     |
                                                                     v
+---------------------------------------------------------------------------------+
|                         STORY-GENERATION-WORKFLOW                               |
|  +-----------------+    +-----------------+    +-----------------------------+  |
|  |  Audio Routes   |--->|   TTSService    |--->|  TTS Provider (ITTSService) |  |
|  |  /api/stories/* |    |   Orchestrator  |    |  Google Gemini or OpenAI    |  |
|  +-----------------+    +--------+--------+    +-----------------------------+  |
|                                  |                                              |
|                    +-------------+-------------+-------------+                  |
|                    v                           v             v                  |
|           +----------------+          +----------------+  +------------------+  |
|           | Text Chunking  |          | Audio Concat   |  | Background Music |  |
|           | (if needed)    |          | (FFmpeg)       |  | Mixing (FFmpeg)  |  |
|           +----------------+          +----------------+  +------------------+  |
+---------------------------------------------------------------------------------+
```

---

## Step-by-Step Process

### Phase 1: User Interface (mythoria-webapp)

#### 1.1 Voice Configuration

**File:** `src/lib/voice-options.ts`

The webapp determines which TTS provider is configured via environment variable:

```typescript
// Reads NEXT_PUBLIC_TTS_PROVIDER from environment
export function getTTSProvider(): TTSProvider {
  return (process.env.NEXT_PUBLIC_TTS_PROVIDER as TTSProvider) || 'google-genai';
}
```

Based on the provider, it exposes the available voices:

| Provider      | Voices Available                                                         |
| ------------- | ------------------------------------------------------------------------ |
| Google Gemini | Charon, Aoede, Puck, Kore, Fenrir, Orus, Zephyr, Sulafat                 |
| OpenAI        | alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse |

The voice list and the default-voice mapping (see [Voice Resolution](#voice-resolution)) must stay in sync with `src/services/voice-registry.ts` in story-generation-workflow and `mythoria_admin/src/lib/voice-options.ts`.

#### 1.2 Voice Selection Component

**File:** `src/components/VoiceSelector.tsx`

Users select their preferred narrator voice from a dropdown. The selector may be left on automatic selection (`'auto'`), in which case the workflow picks a voice for the story's target audience. Voice names are translated via locale files:

**Files:** `src/messages/{locale}/Voices.json`

```json
{
  "Charon": "Charon - Warm narrator, perfect for storytelling",
  "Aoede": "Aoede - Light and pleasant voice",
  ...
}
```

#### 1.3 Audiobook Generation Trigger

**File:** `src/components/AudiobookGenerationTrigger.tsx`

When the user clicks "Generate Audiobook", this component:

1. Validates the story is ready for audio generation
2. Captures the selected voice (or `'auto'`)
3. Captures the background music toggle state (on by default)
4. Calls the server action

#### 1.4 Server Action

**File:** `src/app/[locale]/story/[id]/actions.ts` (or similar)

The server action:

1. Authenticates the user via Clerk
2. Validates the story belongs to the user
3. Makes an HTTP POST request to the story-generation-workflow service

```typescript
const response = await fetch(`${SGW_BASE_URL}/api/stories/${storyId}/audio`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': process.env.SGW_API_KEY,
  },
  body: JSON.stringify({ voice: selectedVoice }),
});
```

---

### Phase 2: Story Generation Workflow Service

#### 2.1 Audio Routes

**File:** `src/routes/audio.ts`

The endpoint receives the request and:

1. Validates the API key
2. Fetches the story and all chapters from the database
3. Resolves the voice (see [Voice Resolution](#voice-resolution)) when `voice` is empty, missing or `'auto'`
4. Iterates through each chapter, calling the TTSService

```typescript
// For each chapter
for (const chapter of chapters) {
  const result = await ttsService.generateChapterAudioFromText(
    storyId,
    chapter.chapterNumber,
    chapter.content,
    story.title,
    voice,
    'chapter',
    {
      storyAuthor: story.author,
      storyLanguage: story.storyLanguage,
      isFirstChapter: chapter.chapterNumber === 1,
      dedicatoryMessage: story.dedicationMessage,
    },
  );
}
```

#### 2.2 TTS Service (Orchestrator)

**File:** `src/services/tts.ts`

The `TTSService` class orchestrates the entire audio generation process:

**Constructor - Provider Selection:**

```typescript
constructor() {
  // Get TTS provider from gateway (reads TTS_PROVIDER env var)
  this.ttsProvider = getTTSGateway().getTTSService();
}
```

**Method: `generateChapterAudioFromText()`**

This method performs the following steps:

##### Step 1: Build Chapter Text

For the **first chapter**, includes:

- Story title
- Dedication message (if any)
- Mythoria credit message (translated)
- "Chapter 1" (translated)
- Chapter content

For **subsequent chapters**:

- "Chapter N" (translated)
- Chapter content

The title, dedication, Mythoria credit, chapter heading and chapter body are joined with blank lines (`\n\n`) for every provider. The paragraph break is the pause. Inline pause tags (`<short pause>`, `<long pause>`) are deliberately not used because the model can read them aloud (translated) in the generated audio; both providers also strip any stray pause tag defensively before sending the request.

**File:** `src/services/tts-utils.ts`

```typescript
// First chapter
text = [
  `${storyTitle}.`,
  dedicatoryMessage && `${dedicatoryMessage}.`,
  getMythoriaCreditMessage(storyLanguage, authorName),
  `${chapterWord} 1.`,
  processTextForTTS(chapterContent),
]
  .filter(Boolean)
  .join('\n\n');

// Other chapters
text = [`${chapterWord} ${chapterNumber}.`, processTextForTTS(chapterContent)].join('\n\n');
```

Digits are no longer spelled out as English words, except for OpenAI and English (`en-*`) text.

##### Step 2: Resolve Delivery Style and Language

**File:** `src/services/audio-prompt.ts`

The `AudioPromptService` loads a compact, per-locale delivery style from JSON files. Accent is no longer enforced through long system prompts: the accent comes from the language code and the voice comes from the voice name.

**Files:** `src/prompts/audio/{locale}.json`

```json
{
  "language": "pt-PT",
  "languageName": "Portuguese (Portugal)",
  "baseStyle": {
    "toddlers": "Soft, gentle, sing-song storyteller, slow and soothing",
    "children": "Warm, playful storyteller, unhurried, smiling through the words",
    "young adults": "Engaging, expressive storyteller with natural, lively pacing",
    "adults": "Rich, immersive narrator, measured and expressive",
    "general audience": "Warm, engaging storyteller with natural, expressive pacing"
  },
  "translations": {
    "audioIntro": "Esta história foi imaginada por {author} e criada com Mythoria. Conta a tua própria história.",
    "chapter": "Capítulo"
  }
}
```

- One `baseStyle` line per target age: `toddlers`, `children`, `young adults`, `adults`, `general audience`. `all_ages` (and unknown or missing ages) map to `general audience`.
- `AudioPromptService.getBaseStyle(locale, targetAge)` resolves the style. Fallback chain: locale file, then `en-US`, then built-in defaults.
- `TTSService` passes the style per chunk as `TTSOptions.style` (via `resolveChunkStyle()`), together with `languageCode` (the story locale as a BCP-47 tag, e.g. `pt-PT`). The language code is what keeps the accent native.
- The style must not mention accent, age, gender or "keep the voice consistent".

**Key Method: `getTTSSystemPrompt()`**

For OpenAI only, `getTTSSystemPrompt()` builds the instructions text (accent hint from `DEFAULT_ACCENT_PROMPTS` plus the base style). It is sent through the API `instructions` parameter. `TTSService` calls it only when the effective provider is `openai`; for Gemini it is neither built nor passed (the base style comes from `getBaseStyle()`).

Translation strings (`audioIntro`, `chapter`) must keep their diacritics ("Capítulo", "história") because TTS pronunciation depends on them, and the credit sentence uses a full stop, not " - ", between the Mythoria mention and the call to action.

##### Step 3: Check Text Length and Chunk if Needed

**File:** `src/services/text-chunking.ts`

The system checks if the text exceeds the provider's character limit (`getMaxTextLength()`):

| Provider      | Max Characters |
| ------------- | -------------- |
| OpenAI        | 4,096          |
| Google Gemini | 4,500          |

**If text exceeds limit**, intelligent chunking is applied:

```typescript
if (needsChunking(chapterText, maxTextLength)) {
  const chunks = splitTextIntoChunks(chapterText, maxTextLength, {
    preferParagraphs: true, // Split at paragraph breaks first
    minChunkSize: 500, // Avoid tiny chunks
    preserveDialogue: true, // Keep quotes together
  });
}
```

**Chunking Algorithm:**

1. **Paragraph Split**: First tries to split on double newlines
2. **Sentence Split**: If paragraphs are too long, splits at sentence boundaries
3. **Abbreviation Handling**: Recognizes "Mr.", "Dr.", etc. as non-sentence-endings
4. **Dialogue Preservation**: Keeps quoted text together when possible
5. **Fallback**: Very long sentences split at commas/semicolons
6. **Hard Split**: As last resort, splits at character limit

Gemini chapters are split at paragraph or sentence boundaries before they exceed 4,500 characters. `gemini-3.8-flash-tts` accepts 8,192 input and 16,384 output tokens (about 655 s of audio); 4,500 characters is roughly 310 s of audio (~7,800 audio tokens) per call, and a single ~4,900-character request was validated live with a complete transcript. A final remainder smaller than `minChunkSize` is merged into the previous chunk, and chunks keep their paragraph breaks (so the heading pauses survive chunking).

##### Step 4: Expressive Direction (optional)

When `TTS_EXPRESSIVE_DIRECTION_ENABLED=true`, each chunk first goes through the narration director. See [Expressive Narration](#expressive-narration). When the flag is off (the default), each chunk is sent with the plain base style.

##### Step 5: Generate Audio via Provider

**File:** `src/ai/tts-gateway.ts`

The `TTSGateway` is a factory that returns the appropriate provider:

```typescript
export function getTTSGateway(): TTSGateway {
  if (!instance) {
    instance = TTSGateway.fromEnvironment();
  }
  return instance;
}
```

**Provider Selection (from environment):**

```typescript
static fromEnvironment(): TTSGateway {
  const provider = (process.env.TTS_PROVIDER || 'google-genai') as TTSProvider;
  // Returns GoogleGenAITTSService or OpenAITTSService
}
```

---

### Phase 3: TTS Providers

#### 3.1 Interface

**File:** `src/ai/interfaces.ts`

All providers implement `ITTSService`:

```typescript
interface ITTSService {
  synthesize(text: string, options?: TTSOptions): Promise<TTSResult>;
  getMaxTextLength(): number;
  getProvider(): TTSProvider;
}

interface TTSResult {
  buffer: Buffer; // MP3 audio data
  format: 'mp3' | 'wav' | 'pcm';
  sampleRate: number;
  voice: string;
  model: string;
  provider: TTSProvider;
}
```

#### 3.2 Google Gemini TTS Provider (default)

**File:** `src/ai/providers/google-genai/tts.ts`

- Model: `gemini-3.8-flash-tts`. This is the only supported Gemini TTS model. With `TTS_PROVIDER=google-genai`, config validation fails for any other `TTS_MODEL` (no 3.1 or Flash-Lite support).
- Request: `models.generateContent` with `responseModalities: ['AUDIO']`, `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName` and `speechConfig.languageCode` (story locale).
- The transcript is sent verbatim: no director's notes and no preamble. Delivery direction goes in `Part.speechMetadata.style`.
- Inline vocalization tags use angle brackets (e.g. `<laughs>`, `<sigh>`) and are rendered as sounds. Pause tags (`<short pause>`, `<long pause>`) are deliberately not used: the model can read them aloud, and paragraph breaks already create the pauses. The provider strips any stray pause tag from the text and from every segment before the request (logged at debug).
- No legacy `systemPrompt` is accepted or logged for Gemini; style plus `languageCode` replace it.

Simplified excerpt (see the file for the exact request shape, including per-segment parts):

```typescript
class GoogleGenAITTSService implements ITTSService {
  async synthesize(text: string, options?: TTSOptions): Promise<TTSResult> {
    const synthesis = await withRetry(
      async () => {
        const response = await this.client.models.generateContent({
          model: 'gemini-3.8-flash-tts',
          contents: [
            {
              role: 'user',
              parts: buildGeminiSpeechParts(text, style, options?.segments),
            },
          ],
          config: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              languageCode: options?.languageCode,
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: voice },
              },
            },
          },
        });

        // Audio validation is inside the retry boundary because the model can
        // occasionally return an empty or text-only response.
        return extractGeminiAudio(response);
      },
      { maxAttempts: 3 },
    );

    // Response is WAV (RIFF, 24 kHz mono 16-bit); convert to MP3 128 kbps with ffmpeg
    const mp3Buffer = await this.convertToMp3(synthesis.audioBuffer, wav);

    return { buffer: mp3Buffer, format: 'mp3', ... };
  }

  getMaxTextLength(): number {
    return 4500; // 8,192 input / 16,384 output token limits; ~310 s of audio per call
  }
}
```

- The response is WAV (RIFF, 24 kHz mono 16-bit), converted to MP3 at 128 kbps with ffmpeg (`FFMPEG_BINARY`).
- Duration is measured with ffprobe (`FFPROBE_BINARY`). An estimate is used as a fallback.
- Empty or text-only responses are retried inside the provider.
- Safety blocks and output-token exhaustion are reported as structured, non-retryable errors.
- Logs capture response IDs, finish reasons, part types and MIME types without recording transcript or audio content.
- Token usage is recorded from the real `usageMetadata` (input and output tokens). See [Token Usage and Pricing](#token-usage-and-pricing).

#### 3.3 OpenAI TTS Provider (alternative)

**File:** `src/ai/providers/openai/tts.ts`

```typescript
class OpenAITTSService implements ITTSService {
  async synthesize(text: string, options?: TTSOptions): Promise<TTSResult> {
    const response = await this.client.audio.speech.create({
      model: options?.model || 'gpt-4o-mini-tts',
      voice: options?.voice || 'coral',
      input: text,
      instructions: options?.instructions, // from getTTSSystemPrompt(); sent only for gpt-4o-mini-tts
      response_format: 'mp3',
      speed: options?.speed || 1.0,
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    return { buffer, format: 'mp3', ... };
  }

  getMaxTextLength(): number {
    return 4096;
  }
}
```

Any stray pause tag is stripped defensively before the request; paragraph breaks in the text are preserved.

---

### Phase 4: Expressive Narration

#### Overview

Expressive narration is controlled by **`TTS_EXPRESSIVE_DIRECTION_ENABLED`**. The code default is `false`, but deployments (`cloudbuild.yaml`) and `.env.local` set it to `true`, with `TTS_DIRECTION_MODEL=gemini-3.8-flash`. When it is off, every chunk is sent as plain text with the base style.

When it is on, each chunk gets one text-LLM call before synthesis:

- **Service:** `src/services/narration-direction.ts`
- **Prompt:** `src/prompts/en-US/narration-direction.json`
- **Model:** `TTS_DIRECTION_MODEL`, falling back to `GOOGLE_GENAI_MODEL` when unset
- **Output:** 1-4 segments, each `{text, mood}`
- Each segment is sent as its own part, with style `"<baseStyle>; <mood>"`.

#### Guardrails

| Guardrail       | Rule                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Verbatim check  | Segment text must match the source chunk; the director may add tags but may not rewrite the story                                    |
| Tag whitelist   | Only `<sigh>`, `<laughs>`, `<chuckle>`, `<giggle>`, `<gasp>`, `<whispers>`, `<breath>`. Pause tags are rejected like any unknown tag |
| Tag density     | At most 1 tag per 120 words                                                                                                          |
| Style sanitizer | No accent, age, gender or identity words; at most 80 characters                                                                      |

Any failure (LLM error, guardrail violation, parse error) falls back to the plain chunk with the base style. Narration never blocks on direction.

#### Cost tracking

Direction calls are tracked as `audio_generation` with `inputPromptJson.operation = 'narration_direction'`. No database enum change is needed.

---

### Phase 5: Audio Concatenation (for chunked text)

**File:** `src/services/audio-concatenation.ts`

When text is split into multiple chunks, each chunk generates a separate audio buffer. These are concatenated losslessly using FFmpeg:

```typescript
async function concatenateAudioBuffers(buffers: Buffer[]): Promise<ConcatenationResult> {
  // 1. Write each buffer to a temp file
  for (const buffer of buffers) {
    await fs.writeFile(chunkPath, buffer);
  }

  // 2. Create FFmpeg concat list
  // file 'chunk_0000.mp3'
  // file 'chunk_0001.mp3'
  // ...

  // 3. Run FFmpeg with concat demuxer (lossless)
  ffmpeg()
    .input(listFilePath)
    .inputOptions(['-f concat', '-safe 0'])
    .outputOptions(['-c copy'])  // No re-encoding!
    .output(outputFilePath)
    .run();

  // 4. Read concatenated file and cleanup temps
  const result = await fs.readFile(outputFilePath);
  await cleanupTempFiles(...);

  return { buffer: result, chunkCount: buffers.length };
}
```

---

### Phase 6: Storage and Database Update

Back in `tts.ts`, after audio generation:

#### 6.1 Upload to Cloud Storage

**File:** `src/services/storage.ts`

```typescript
const audioFilename = `${storyId}/audio/chapter_01.mp3`;
const audioUrl = await this.storageService.uploadFile(audioFilename, audioBuffer, 'audio/mpeg');
// Returns: gs://mythoria-generated-stories/{storyId}/audio/chapter_01.mp3
```

#### 6.2 Update Database

**File:** `src/services/chapters.ts`

```typescript
await this.chaptersService.updateChapterAudio(storyId, chapterNumber, audioUrl);
// Updates chapters.audioUri in mythoria_db
```

#### 6.3 Track Token Usage

**File:** `src/services/token-usage-tracking.ts`

```typescript
await tokenUsageTrackingService.recordUsage({
  authorId: story.authorId,
  storyId: storyId,
  action: 'audio_generation',
  aiModel: actualModel,
  inputTokens: usage.inputTokens, // real usageMetadata for Gemini TTS
  outputTokens: usage.outputTokens,
});
```

---

## Voice Resolution

**Files:** `src/services/voice-registry.ts` (single source in SGW), `mythoria-webapp/src/lib/voice-options.ts` and `mythoria_admin/src/lib/voice-options.ts` (must mirror it).

- Gemini voices (unchanged): Charon, Aoede, Puck, Kore, Fenrir, Orus, Zephyr, Sulafat.
- An empty, missing or `'auto'` voice resolves with `resolveDefaultVoice(provider, targetAudience)`.
- `TTS_VOICE` is used only when the story has no target audience.
- The workflow `workflows/audiobook-generation.yaml` now defaults the voice to `""` (automatic).

| Target audience      | Gemini default | OpenAI default |
| -------------------- | -------------- | -------------- |
| `children_0-2`       | Sulafat        | coral          |
| `children_3-6`       | Puck           | coral          |
| `children_7-10`      | Puck           | coral          |
| `children_11-14`     | Puck           | coral          |
| `young_adult_15-17`  | Zephyr         | coral          |
| `adult_18+`          | Charon         | coral          |
| `all_ages` / unknown | Sulafat        | coral          |

---

## Token Usage and Pricing

- TTS records the real input and output tokens from `usageMetadata`.
- Pricing for `gemini-3.8-flash-tts` is in `src/services/model-pricing.ts` as `effectiveFrom` tiers:

| Period           | Input (per 1M tokens) | Audio output (per 1M tokens) |
| ---------------- | --------------------- | ---------------------------- |
| Until 2026-12-31 | $0.50                 | $9.00                        |
| From 2027-01-01  | $1.00                 | $18.00                       |

---

## Configuration Summary

### Environment Variables

| Variable                           | Location                  | Default                | Description                                                             |
| ---------------------------------- | ------------------------- | ---------------------- | ----------------------------------------------------------------------- |
| `NEXT_PUBLIC_TTS_PROVIDER`         | mythoria-webapp           | `google-genai`         | Provider for voice list (client-side)                                   |
| `TTS_PROVIDER`                     | story-generation-workflow | `google-genai`         | Active provider (`google-genai` or `openai`)                            |
| `TTS_MODEL`                        | story-generation-workflow | `gemini-3.8-flash-tts` | TTS model. With `google-genai`, only `gemini-3.8-flash-tts` is accepted |
| `TTS_VOICE`                        | story-generation-workflow | `Charon`               | Fallback voice, used only when the story has no target audience         |
| `TTS_SPEED`                        | story-generation-workflow | `1`                    | Playback speed (OpenAI)                                                 |
| `TTS_EXPRESSIVE_DIRECTION_ENABLED` | story-generation-workflow | `false`                | Enables the per-chunk narration director (see Expressive Narration)     |
| `TTS_DIRECTION_MODEL`              | story-generation-workflow | `GOOGLE_GENAI_MODEL`   | Text model used by the narration director                               |
| `FFPROBE_BINARY`                   | story-generation-workflow | `ffprobe`              | ffprobe executable used to measure audio duration                       |
| `FFMPEG_BINARY`                    | story-generation-workflow | `ffmpeg`               | ffmpeg executable used for MP3 conversion, concatenation and mixing     |
| `OPENAI_API_KEY`                   | story-generation-workflow | -                      | OpenAI API credentials                                                  |
| `GOOGLE_GENAI_API_KEY`             | story-generation-workflow | -                      | Google AI API credentials                                               |

### Current Production Configuration

```
TTS_PROVIDER=google-genai
TTS_MODEL=gemini-3.8-flash-tts
TTS_VOICE=Charon
TTS_EXPRESSIVE_DIRECTION_ENABLED=true
TTS_DIRECTION_MODEL=gemini-3.8-flash
```

### Rollback

There is no rollback to Gemini 3.1 models. To roll back, redeploy the previous Cloud Run revision.

---

## File Reference

| File                                            | Service | Purpose                                              |
| ----------------------------------------------- | ------- | ---------------------------------------------------- |
| `src/lib/voice-options.ts`                      | webapp  | Voice list utilities                                 |
| `src/components/VoiceSelector.tsx`              | webapp  | Voice dropdown UI                                    |
| `src/components/AudiobookGenerationTrigger.tsx` | webapp  | Generate button + background music toggle            |
| `src/messages/*/Voices.json`                    | webapp  | Voice translations (5 locales)                       |
| `src/routes/audio.ts`                           | sgw     | API endpoint                                         |
| `src/services/tts.ts`                           | sgw     | Main orchestrator                                    |
| `src/services/tts-utils.ts`                     | sgw     | Text preparation utilities                           |
| `src/services/text-chunking.ts`                 | sgw     | Intelligent text splitting                           |
| `src/services/narration-direction.ts`           | sgw     | Expressive narration director (flagged, default off) |
| `src/services/voice-registry.ts`                | sgw     | Voice lists and default voice resolution             |
| `src/services/audio-concatenation.ts`           | sgw     | FFmpeg audio joining + mixing                        |
| `src/services/background-music.ts`              | sgw     | Background music selection                           |
| `src/services/audio-prompt.ts`                  | sgw     | Per-locale base styles and OpenAI instructions       |
| `src/services/model-pricing.ts`                 | sgw     | TTS pricing tiers                                    |
| `src/ai/tts-gateway.ts`                         | sgw     | Provider factory                                     |
| `src/ai/interfaces.ts`                          | sgw     | ITTSService interface and TTSOptions                 |
| `src/ai/providers/google-genai/tts.ts`          | sgw     | Gemini implementation (default)                      |
| `src/ai/providers/openai/tts.ts`                | sgw     | OpenAI implementation                                |
| `src/prompts/audio/*.json`                      | sgw     | Per-locale base styles and translations              |
| `src/prompts/en-US/narration-direction.json`    | sgw     | Narration director prompt                            |
| `src/backgroundMusics/*.mp3`                    | sgw     | Background music files                               |

---

## Error Handling

1. **Text too long**: Automatically chunked (no longer truncated)
2. **API failures**: Logged and re-thrown with context
3. **FFmpeg errors**: Caught with stderr logging, temp files cleaned up
4. **Invalid voice**: Falls back to the resolved default voice for the audience
5. **Missing translations**: Falls back to English
6. **Missing background music**: Skips mixing, returns narration-only audio
7. **Missing base style**: Falls back to `en-US`, then built-in defaults
8. **Narration direction failure**: Plain chunk with base style; narration continues

---

## Supported Locales

The audio narration system supports the following languages for voice translations and audio prompts:

1. **American English** (`en-US`)
2. **British English** (`en-GB`)
3. **European Portuguese** (`pt-PT`)
4. **Brazilian Portuguese** (`pt-BR`)
5. **European Spanish** (`es-ES`)
6. **French** (`fr-FR`)
7. **German** (`de-DE`)
8. **Italian** (`it-IT`)
9. **Dutch** (`nl-NL`)
10. **Polish** (`pl-PL`)

The story locale is sent to Gemini as `speechConfig.languageCode`, which keeps the accent native. Adding a locale requires a valid BCP-47 tag.

---

## Background Music System

### Overview

The background music feature adds ambient music to audiobook narration based on the story's target audience and novel style. Music is mixed at a low volume (default 10%) with music-only fade-in/fade-out effects.

### Music Selection Logic

**File:** `src/services/background-music.ts`

Music is automatically selected based on two story attributes:

- **Target Audience**: `children_0-2`, `children_3-6`, `children_7-10`, `children_11-14`, `young_adult_15-17`, `adult_18+`, `all_ages`
- **Novel Style**: `adventure`, `fantasy`, `mystery`, `romance`, `science_fiction`, `historical`, `contemporary`, `fairy_tale`, `comedy`, `drama`, `horror`, `thriller`, `biography`, `educational`, `poetry`, `sports_adventure`

### Available Background Music Tracks

| Code                     | Description                       | Best For                              |
| ------------------------ | --------------------------------- | ------------------------------------- |
| `bg_soft_bedtime`        | Ultra-gentle, lullaby / calm      | Toddlers (0-2), bedtime stories       |
| `bg_kids_playful_day`    | Light, happy, playful             | Young children, comedy, light stories |
| `bg_kids_adventure`      | Upbeat, adventurous but safe      | Children's adventure, mystery         |
| `bg_kids_magic_fantasy`  | Whimsical, magical                | Fantasy, fairy tales for children     |
| `bg_tween_reflective`    | Gentle emotional / coming-of-age  | Middle grade, drama, serious themes   |
| `bg_teen_adventure`      | More energetic adventure / action | YA adventure, action stories          |
| `bg_dark_tension`        | Suspense / horror / thriller      | Horror, thriller (15+)                |
| `bg_romantic_warm`       | Intimate, warm                    | Romance, family love stories          |
| `bg_adult_neutral_focus` | Neutral, low-key                  | Serious/educational adult content     |
| `bg_scifi_space_ambient` | Space / tech / futuristic         | Science fiction                       |

### Audio Mixing Process

**File:** `src/services/audio-concatenation.ts` - `mixAudioWithBackground()`

1. **Looping**: Background music is looped if shorter than narration
2. **Fade In**: Music fades in from the beginning and reaches full configured music volume within 2s maximum
3. **Volume Reduction**: Background music volume is reduced (default 10%)
4. **Fade Out**: Music fade-out starts only in the final 2s maximum of the narration
5. **Mixing**: FFmpeg `amix` filter combines narration (100%) with background without fading narration
6. **Peak Protection**: `alimiter` prevents clipping after the non-normalized mix

The production image installs the Debian FFmpeg package and validates at build time that the
`amix` filter supports `normalize`. Application modules use `FFMPEG_BINARY` rather than a bundled,
platform-specific npm binary. A requested music mix that fails is returned as the non-retryable
`FFMPEG_MIX_FAILED` dependency error; the service does not silently publish narration-only audio as
a fully successful mixed audiobook.

### Configuration

| Variable                    | Default  | Description                                                              |
| --------------------------- | -------- | ------------------------------------------------------------------------ |
| `BACKGROUND_MUSIC_ENABLED`  | `true`   | Global enable/disable for background music                               |
| `BACKGROUND_MUSIC_VOLUME`   | `0.1`    | Volume level (0.0 to 1.0)                                                |
| `BACKGROUND_MUSIC_FADE_IN`  | `0.5`    | Music fade-in duration in seconds, capped at 2s                          |
| `BACKGROUND_MUSIC_FADE_OUT` | `0.5`    | Music fade-out duration in seconds, capped at 2s and anchored to the end |
| `FFMPEG_BINARY`             | `ffmpeg` | System FFmpeg executable; `/usr/bin/ffmpeg` in the production container  |

### User Control

Users can toggle background music via the "Include background music" checkbox in the audiobook generation UI. This setting is passed through:

1. UI Component (`AudiobookGenerationTrigger.tsx`)
2. API Route (`/api/stories/{id}/generate-audiobook`)
3. Pub/Sub Message (`includeBackgroundMusic` field)
4. Workflow YAML (`audiobook-generation.yaml`)
5. Internal API (`/internal/audiobook/chapter`)
6. TTS Service (`generateChapterAudioFromText`)

### Adding New Background Music

1. Create MP3 file with appropriate naming: `bg_{category}_{description}.mp3`
2. Place in `src/backgroundMusics/` folder
3. Add code to `BackgroundMusicCode` type in `background-music.ts`
4. Update `selectBackgroundMusic()` function with selection logic
5. Music files should be:
   - Loopable (seamless when repeated)
   - Instrumental only (no vocals)
   - Appropriate volume level
   - MP3 format, 128kbps or higher

---

## Adding a New TTS Provider

To add a new TTS provider (e.g., ElevenLabs):

1. Create provider file: `src/ai/providers/elevenlabs/tts.ts`
2. Implement `ITTSService` interface
3. Add provider type to `TTSProvider` in `src/ai/interfaces.ts`
4. Update `TTSGateway.fromEnvironment()` in `src/ai/tts-gateway.ts`
5. Add voice list and default-voice mapping to `src/services/voice-registry.ts`, then mirror them in the webapp's `src/lib/voice-options.ts` and admin's `src/lib/voice-options.ts`
6. Add voice translations to `src/messages/*/Voices.json`
7. Implement `getMaxTextLength()` in the provider
