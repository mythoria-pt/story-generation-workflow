# Audio Narration System - Complete Technical Documentation

## Overview

The Mythoria audio narration system transforms written story chapters into spoken audio using AI-powered Text-to-Speech (TTS). The system spans two services: **mythoria-webapp** (user interface and orchestration) and **story-generation-workflow** (audio generation engine).

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
|  |  /api/stories/* |    |   Orchestrator  |    |  OpenAI or Google Gemini    |  |
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
| OpenAI        | alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse |
| Google Gemini | Charon, Aoede, Puck, Kore, Fenrir, Orus, Zephyr, Sulafat                 |

#### 1.2 Voice Selection Component

**File:** `src/components/VoiceSelector.tsx`

Users select their preferred narrator voice from a dropdown. Voice names are translated via locale files:

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
2. Captures the selected voice
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
3. Iterates through each chapter, calling the TTSService

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

**File:** `src/services/tts-utils.ts`

```typescript
// First chapter
text = storyTitle + '.';
text += dedicatoryMessage;
text += getMythoriaCreditMessage(storyLanguage, authorName);
text += `${chapterWord} 1.`;
text += processTextForTTS(chapterContent);

// Other chapters
text = `${chapterWord} ${chapterNumber}.`;
text += processTextForTTS(chapterContent);
```

##### Step 2: Apply Audio Prompts and Accent Enforcement

**File:** `src/services/audio-prompt.ts`

The `AudioPromptService` loads language-specific TTS instructions from JSON files and provides accent enforcement prompts that are sent as system instructions to the TTS API.

**Files:** `src/prompts/audio/{locale}.json`

```json
{
  "language": "pt-PT",
  "languageName": "Portuguese (Portugal)",
  "systemPrompt": "<narrator_profile>...</narrator_profile>\n<accent_enforcement>CRITICAL: You MUST speak strictly in European Portuguese (pt-PT)...</accent_enforcement>\n<performance_style>...</performance_style>\n<technical_requirements>...</technical_requirements>",
  "targetAgeOptions": ["criancas pequenas", "criancas", "jovens", "adultos"],
  "instructions": ["Use proper punctuation...", "Speak expressively..."],
  "translations": {
    "audioIntro": "Esta historia foi imaginada por {author}...",
    "chapter": "Capitulo"
  }
}
```

**Key Method: `getTTSSystemPrompt()`**

This method returns the complete system prompt (including accent enforcement) that is sent to the TTS API:

```typescript
const systemPrompt = await AudioPromptService.getTTSSystemPrompt(storyLanguage, targetAge);
// Returns the full system prompt with accent enforcement instructions
```

The system prompt includes an `<accent_enforcement>` section that explicitly instructs the TTS model to:

- Use the correct regional accent (e.g., European Portuguese vs Brazilian Portuguese)
- Avoid incorrect pronunciations from other dialects
- Maintain consistent accent throughout the entire narration

**This prompt is sent with every TTS request, including each chunk when text is split.**

##### Step 3: Check Text Length and Chunk if Needed

**File:** `src/services/text-chunking.ts`

The system checks if the text exceeds the provider's character limit:

| Provider      | Max Characters |
| ------------- | -------------- |
| OpenAI        | 4,096          |
| Google Gemini | 8,000          |

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

##### Step 4: Generate Audio via Provider

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
  const provider = (process.env.TTS_PROVIDER || 'openai') as TTSProvider;
  // Returns OpenAITTSService or GoogleGenAITTSService
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

#### 3.2 OpenAI TTS Provider

**File:** `src/ai/providers/openai/tts.ts`

```typescript
class OpenAITTSService implements ITTSService {
  async synthesize(text: string, options?: TTSOptions): Promise<TTSResult> {
    const response = await this.client.audio.speech.create({
      model: options?.model || 'gpt-4o-mini-tts',
      voice: options?.voice || 'coral',
      input: text,
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

#### 3.3 Google Gemini TTS Provider

**File:** `src/ai/providers/google-genai/tts.ts`

```typescript
class GoogleGenAITTSService implements ITTSService {
  async synthesize(text: string, options?: TTSOptions): Promise<TTSResult> {
    // Gemini returns raw PCM audio
    const response = await this.client.models.generateContent({
      model: 'gemini-2.5-pro-preview-tts',
      contents: text,
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: voice },
          },
        },
      },
    });

    // Extract PCM data and convert to MP3
    const pcmBuffer = Buffer.from(audioPart.inlineData.data, 'base64');
    const mp3Buffer = await this.convertPcmToMp3(pcmBuffer);

    return { buffer: mp3Buffer, format: 'mp3', ... };
  }

  // PCM to MP3 conversion using fluent-ffmpeg
  private async convertPcmToMp3(pcmBuffer: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      ffmpeg(inputStream)
        .inputFormat('s16le')           // 16-bit signed little-endian
        .inputOptions(['-ar 24000', '-ac 1'])  // 24kHz, mono
        .audioCodec('libmp3lame')
        .audioBitrate('128k')
        .format('mp3')
        .pipe(outputStream);
    });
  }

  getMaxTextLength(): number {
    return 8000;
  }
}
```

---

### Phase 4: Audio Concatenation (for chunked text)

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

### Phase 5: Storage and Database Update

Back in `tts.ts`, after audio generation:

#### 5.1 Upload to Cloud Storage

**File:** `src/services/storage.ts`

```typescript
const audioFilename = `${storyId}/audio/chapter_01.mp3`;
const audioUrl = await this.storageService.uploadFile(audioFilename, audioBuffer, 'audio/mpeg');
// Returns: gs://mythoria-generated-stories/{storyId}/audio/chapter_01.mp3
```

#### 5.2 Update Database

**File:** `src/services/chapters.ts`

```typescript
await this.chaptersService.updateChapterAudio(storyId, chapterNumber, audioUrl);
// Updates chapters.audioUri in mythoria_db
```

#### 5.3 Track Token Usage

**File:** `src/services/token-usage-tracking.ts`

```typescript
await tokenUsageTrackingService.recordUsage({
  authorId: story.authorId,
  storyId: storyId,
  action: 'audio_generation',
  aiModel: actualModel,
  inputTokens: chapterText.length, // Characters
  outputTokens: 0,
});
```

---

## Configuration Summary

### Environment Variables

| Variable                   | Location                  | Description                                     |
| -------------------------- | ------------------------- | ----------------------------------------------- |
| `NEXT_PUBLIC_TTS_PROVIDER` | mythoria-webapp           | Provider for voice list (client-side)           |
| `TTS_PROVIDER`             | story-generation-workflow | Active provider (`openai` or `google-genai`)    |
| `TTS_MODEL`                | story-generation-workflow | Model name (e.g., `gemini-2.5-pro-preview-tts`) |
| `TTS_VOICE`                | story-generation-workflow | Default voice (e.g., `Charon`)                  |
| `TTS_SPEED`                | story-generation-workflow | Playback speed (default: `1.0`)                 |
| `OPENAI_API_KEY`           | story-generation-workflow | OpenAI API credentials                          |
| `GOOGLE_GENAI_API_KEY`     | story-generation-workflow | Google AI API credentials                       |

### Current Production Configuration

```
TTS_PROVIDER=google-genai
TTS_MODEL=gemini-2.5-pro-preview-tts
TTS_VOICE=Charon
```

---

## File Reference

| File                                            | Service | Purpose                                                  |
| ----------------------------------------------- | ------- | -------------------------------------------------------- |
| `src/lib/voice-options.ts`                      | webapp  | Voice list utilities                                     |
| `src/components/VoiceSelector.tsx`              | webapp  | Voice dropdown UI                                        |
| `src/components/AudiobookGenerationTrigger.tsx` | webapp  | Generate button + background music toggle                |
| `src/messages/*/Voices.json`                    | webapp  | Voice translations (5 locales)                           |
| `src/routes/audio.ts`                           | sgw     | API endpoint                                             |
| `src/services/tts.ts`                           | sgw     | Main orchestrator                                        |
| `src/services/tts-utils.ts`                     | sgw     | Text preparation utilities                               |
| `src/services/text-chunking.ts`                 | sgw     | Intelligent text splitting                               |
| `src/services/audio-concatenation.ts`           | sgw     | FFmpeg audio joining + mixing                            |
| `src/services/background-music.ts`              | sgw     | Background music selection                               |
| `src/services/audio-prompt.ts`                  | sgw     | Language-specific TTS prompts + accent enforcement       |
| `src/ai/tts-gateway.ts`                         | sgw     | Provider factory                                         |
| `src/ai/interfaces.ts`                          | sgw     | ITTSService interface (includes TTSOptions.systemPrompt) |
| `src/ai/providers/openai/tts.ts`                | sgw     | OpenAI implementation with accent enforcement            |
| `src/ai/providers/google-genai/tts.ts`          | sgw     | Gemini implementation with accent enforcement            |
| `src/prompts/audio/*.json`                      | sgw     | Audio prompt configs with accent enforcement             |
| `src/backgroundMusics/*.mp3`                    | sgw     | Background music files                                   |

---

## Error Handling

1. **Text too long**: Automatically chunked (no longer truncated)
2. **API failures**: Logged and re-thrown with context
3. **FFmpeg errors**: Caught with stderr logging, temp files cleaned up
4. **Invalid voice**: Falls back to provider default
5. **Missing translations**: Falls back to English
6. **Missing background music**: Skips mixing, returns narration-only audio
7. **Missing accent prompt**: Falls back to default accent enforcement for known locales

---

## Supported Locales

The audio narration system supports the following languages for voice translations, audio prompts, and accent enforcement:

1. **American English** (`en-US`) - Enforces American accent
2. **British English** (`en-GB`) - Enforces British Received Pronunciation
3. **European Portuguese** (`pt-PT`) - Enforces Lisbon accent, prohibits Brazilian
4. **Brazilian Portuguese** (`pt-BR`) - Enforces Brazilian accent
5. **European Spanish** (`es-ES`) - Enforces Castilian Spanish
6. **French** (`fr-FR`) - Enforces Metropolitan/Parisian French
7. **German** (`de-DE`) - Enforces Standard German (Hochdeutsch)
8. **Italian** (`it-IT`) - Enforces Standard Italian
9. **Dutch** (`nl-NL`) - Enforces Dutch from the Netherlands
10. **Polish** (`pl-PL`) - Enforces Standard Polish

---

## Accent Enforcement System

### Overview

The accent enforcement system ensures that TTS models produce consistent, regionally-correct accents for each supported locale. This is critical for languages with significant regional variations (e.g., European vs Brazilian Portuguese).

### How It Works

1. **System Prompt Loading**: `AudioPromptService.getTTSSystemPrompt()` loads the locale-specific prompt
2. **Prompt Structure**: Each prompt includes an `<accent_enforcement>` section with explicit instructions
3. **API Integration**: The system prompt is sent as a system instruction to both Google Gemini and OpenAI TTS
4. **Chunk Consistency**: The prompt is sent with **every chunk** when text is split for long chapters

### Prompt Structure

```xml
<narrator_profile>
  Defines the narrator persona for the target audience
</narrator_profile>

<accent_enforcement>
  CRITICAL: You MUST speak strictly in [Language] ([locale]).
  - Use authentic [region] pronunciation
  - Do NOT use [other dialect] pronunciations
  - Maintain consistent accent throughout
</accent_enforcement>

<performance_style>
  Guidelines for emotional delivery
</performance_style>

<technical_requirements>
  Technical speech requirements
</technical_requirements>
```

### Provider Implementation

**Google Gemini TTS:**

```typescript
const contents = [
  { role: 'user', parts: [{ text: systemPrompt }] },
  { role: 'user', parts: [{ text: `Read the following text:\n\n${text}` }] },
];
```

**OpenAI TTS:**

```typescript
const inputText = `${systemPrompt}\n\n---\n\nRead the following text:\n\n${text}`;
```

---

## Background Music System

### Overview

The background music feature adds ambient music to audiobook narration based on the story's target audience and novel style. Music is mixed at a low volume (default 20%) with fade-in/fade-out effects.

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
2. **Fade In**: Music fades in over configurable duration (default 1.5s)
3. **Volume Reduction**: Background music volume is reduced (default 20%)
4. **Mixing**: FFmpeg `amix` filter combines narration (100%) with background
5. **Dropout Transition**: Smooth 2-second dropout when narration ends

### Configuration

| Variable                    | Default | Description                                |
| --------------------------- | ------- | ------------------------------------------ |
| `BACKGROUND_MUSIC_ENABLED`  | `true`  | Global enable/disable for background music |
| `BACKGROUND_MUSIC_VOLUME`   | `0.2`   | Volume level (0.0 to 1.0)                  |
| `BACKGROUND_MUSIC_FADE_IN`  | `1.5`   | Fade in duration in seconds                |
| `BACKGROUND_MUSIC_FADE_OUT` | `1.5`   | Fade out duration in seconds               |

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
5. Add voice list to webapp's `src/lib/voice-options.ts`
6. Add voice translations to `src/messages/*/Voices.json`
7. Update `getMaxChunkSize()` in `src/services/tts-utils.ts`
