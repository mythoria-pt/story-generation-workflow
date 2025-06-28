# TTS (Text-to-Speech) Implementation Guide

This document describes the implementation of the audio TTS feature for the Mythoria story generation workflow.

## Overview

The TTS feature generates high-quality audio narration for stories using either OpenAI's TTS API or Google Vertex AI (planned). The system supports multiple languages, voices, and storytelling styles optimized for different age groups.

**Key Features:**
- **Per-Chapter Audio Generation**: Generates audio for each chapter individually to avoid OpenAI TTS prompt limits
- **Sequential Processing**: Processes chapters one by one, uploading each to Google Cloud Storage
- **Dynamic Story URI Updates**: Updates the story's `audiobookUri` field after each chapter is processed
- **Improved User Experience**: Allows users to listen to completed chapters while others are still processing

## Features

### 1. Multi-Provider Support
- **OpenAI TTS**: Primary provider using the `/v1/audio/speech` API
- **Google Vertex AI**: Planned for future implementation (placeholder available)
- **Automatic Fallback**: Falls back to OpenAI if Vertex AI is unavailable

### 2. Language-Specific Audio Prompts
- **Portuguese (pt-PT)**: Portuguese professional storyteller
- **English (en-GB)**: British professional storyteller  
- **English (en-US)**: American professional storyteller
- **French (fr-FR)**: French professional storyteller
- **Spanish (es-ES)**: Spanish professional storyteller
- **German (de-DE)**: German professional storyteller
- **Italian (it-IT)**: Italian professional storyteller

### 3. Configurable Settings
- **Model**: Configurable TTS model (default: `tts-1`)
- **Voice**: Configurable voice (default: `nova`)
- **Speed**: Adjustable speaking speed (default: `0.9x`)
- **Language**: Story language detection and appropriate prompt selection

## Configuration

### Environment Variables

```bash
# TTS Provider Configuration
TTS_PROVIDER=openai          # 'openai' or 'vertex'
TTS_MODEL=tts-1             # OpenAI model (tts-1, tts-1-hd)
TTS_VOICE=nova              # OpenAI voice (alloy, echo, fable, onyx, nova, shimmer)
TTS_SPEED=0.9               # Speaking speed (0.25 to 4.0)

# OpenAI API Configuration
OPENAI_API_KEY=your_key_here
```

### OpenAI Voice Options

| Voice | Characteristics |
|-------|----------------|
| `alloy` | Neutral, balanced |
| `echo` | Male, authoritative |
| `fable` | British accent, storytelling |
| `onyx` | Deep, dramatic |
| `nova` | Young, energetic (default) |
| `shimmer` | Bright, upbeat |

### OpenAI Model Options

| Model | Quality | Speed | Cost |
|-------|---------|-------|------|
| `tts-1` | Standard | Fast | Lower |
| `tts-1-hd` | High | Slower | Higher |

## API Usage

### Generate TTS for a Story

```http
POST /internal/tts/{runId}
```

**Response (Per-Chapter Audio):**
```json
{
  "success": true,
  "runId": "story-run-123",
  "result": {    "audioUrls": {
      "1": "https://storage.googleapis.com/bucket/story-id-123/audio/chapter_1.mp3",
      "2": "https://storage.googleapis.com/bucket/story-id-123/audio/chapter_2.mp3",
      "3": "https://storage.googleapis.com/bucket/story-id-123/audio/chapter_3.mp3"
    },
    "totalDuration": 540,
    "format": "mp3",
    "provider": "openai",
    "voice": "nova",
    "metadata": {
      "totalWords": 1350,
      "generatedAt": "2025-06-17T10:30:00.000Z",
      "model": "tts-1",
      "speed": 0.9,
      "chaptersProcessed": 3
    }
  },
  "step": "tts"
}
```

### Story Audiobook URI Structure

After TTS processing, the story's `audiobookUri` field contains:

```json
{
  "chapter_1": "https://storage.googleapis.com/bucket/story-id-123/audio/chapter_1.mp3",
  "chapter_2": "https://storage.googleapis.com/bucket/story-id-123/audio/chapter_2.mp3",
  "chapter_3": "https://storage.googleapis.com/bucket/story-id-123/audio/chapter_3.mp3"
}
```

## Implementation Details

### Per-Chapter Processing Workflow

The TTS service now processes stories chapter by chapter to avoid OpenAI's character limits and provide better user experience:

1. **Chapter Extraction**: Extracts individual chapters from the story
2. **Sequential Processing**: Processes chapters one by one in order
3. **Audio Generation**: Generates MP3 audio for each chapter using OpenAI TTS
4. **Cloud Upload**: Uploads each chapter's audio file to Google Cloud Storage
5. **URI Update**: Updates the story's `audiobookUri` field with the new chapter link
6. **Progress Tracking**: Logs progress after each chapter completion

### Text Processing for TTS

The system applies several optimizations for better TTS pronunciation:

1. **Chapter Headers**: Adds "Chapter X" introduction (includes story title for first chapter)
2. **Number Conversion**: Converts small numbers (1-20) to words
3. **Punctuation Enhancement**: Adds strategic commas for natural pauses
4. **Dramatic Pauses**: Processes ellipses for dramatic effect
5. **Breathing Room**: Optimizes punctuation for natural flow
6. **Length Limits**: Ensures each chapter stays within OpenAI's 4096 character limit

### Audio Prompt System

Each language has a dedicated JSON prompt file:

```json
{
  "systemPrompt": "You are a professional {Country} storyteller for {{story-target-age}}. You speak passionately and with a lot of emotion. You are fun and funny.",
  "language": "en-US",
  "languageName": "English (American)",
  "targetAgeOptions": ["toddlers", "children", "young adults", "adults"],
  "instructions": [
    "Use proper punctuation for natural pauses",
    "Speak expressively and emotionally",
    "Maintain an appropriate pace for the target age",
    "Use varied intonation to maintain interest",
    "Pronounce all words clearly"
  ]
}
```

### Story Structure for TTS

The generated audio includes:

1. **Title and Author**: Story introduction
2. **Target Age Context**: Helps TTS understand the intended audience
3. **Synopsis** (if available): Story overview
4. **Chapters**: Processed chapter content with natural flow

## Error Handling

The TTS service includes comprehensive error handling:

1. **Missing API Keys**: Clear error messages for configuration issues
2. **Provider Fallback**: Automatic fallback from Vertex AI to OpenAI
3. **Language Fallback**: Falls back to English if language prompt not found
4. **Audio Upload**: Retry logic for storage operations

## Performance Considerations

### Estimated Duration
- **Calculation**: ~150 words per minute speaking rate
- **Accuracy**: ±10% depending on punctuation and pauses

### File Formats
- **Output**: MP3 format for optimal compression and compatibility
- **Quality**: Optimized for storytelling (speech-focused)

### Storage
- **Location**: Google Cloud Storage bucket
- **Path Pattern**: `{storyId}/audio/chapter_{chapterNumber}.mp3`
- **Access**: Public URLs for easy integration
- **Progressive Availability**: Chapters become available as they are processed

## Best Practices

### Writing for TTS

1. **Sentence Length**: Keep sentences 8-15 words for optimal pacing
2. **Contractions**: Use contractions for natural speech
3. **Punctuation**: Use generous punctuation for breathing room
4. **Numbers**: Spell out numbers or provide context
5. **Abbreviations**: Avoid abbreviations or spell them out

### Voice Selection by Target Age

| Age Group | Recommended Voice | Speed | Characteristics |
|-----------|------------------|-------|----------------|
| Toddlers | `nova` | 0.8 | Young, energetic, clear |
| Children | `fable` | 0.9 | Storytelling, engaging |
| Young Adults | `alloy` | 1.0 | Neutral, balanced |
| Adults | `echo` | 1.1 | Authoritative, mature |

## Future Enhancements

### Google Vertex AI Integration

The system is prepared for Google Vertex AI TTS integration:

```typescript
// Placeholder implementation ready for:
// - Google Cloud Text-to-Speech API
// - Custom voice training
// - Regional voice options
// - SSML markup support
```

### Advanced Features (Planned)

1. **SSML Support**: Advanced speech markup for fine control
2. **Custom Voice Training**: Brand-specific voice models
3. **Emotion Control**: Dynamic emotional expression
4. **Multi-Speaker**: Different voices for different characters
5. **Background Music**: Audio mixing capabilities

## Troubleshooting

### Common Issues

1. **"OpenAI client not initialized"**
   - Check `OPENAI_API_KEY` environment variable
   - Verify API key has TTS permissions

2. **"Audio prompt not found"**
   - Check language code format (e.g., `en-US`, not `en`)
   - Verify prompt file exists in `/src/prompts/audio/`

3. **"TTS synthesis failed"**
   - Check OpenAI API quotas and limits
   - Verify text length is within API limits
   - Check network connectivity

### Debugging

Enable debug logging:
```bash
LOG_LEVEL=debug
```

Monitor TTS requests:
```bash
# Check logs for TTS-related entries
grep "TTS" application.log
```

## Integration Examples

### Frontend Integration

```typescript
// Check if story has audio narration
const storyResult = await fetch(`/api/stories/${storyId}`);
const story = await storyResult.json();

if (story.audioUrl) {
  // Play audio narration
  const audio = new Audio(story.audioUrl);
  audio.play();
}
```

### Workflow Integration

The TTS step is integrated into the story generation workflow:

1. Story outline generation
2. Chapter writing
3. Image generation
4. **TTS generation** ← New step
5. Assembly (HTML/PDF)
6. Final delivery

## Security and Privacy

### API Key Management
- OpenAI API keys stored in Google Cloud Secret Manager
- No API keys in code or logs
- Secure key rotation procedures

### Audio Storage
- Generated audio stored in private Google Cloud Storage
- Signed URLs for secure access
- Automatic cleanup policies

### Data Processing
- Text content processed securely
- No audio data cached locally
- GDPR-compliant data handling
