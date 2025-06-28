# TTS Production Improvements

## Overview

This document outlines the improvements made to the `/internal/audiobook/chapter` endpoint and the overall TTS (Text-to-Speech) implementation for production environments.

## Key Changes Made

### 1. Fixed Audio Prompt Handling

**Problem**: System prompts were being incorrectly prepended to the text content, causing the TTS system to read instructions aloud instead of using them as guidance.

**Solution**: 
- Modified `AudioPromptService.enhanceTextForTTS()` to process text based on instructions rather than prepending system prompts
- Added proper voice and speed recommendation logic based on audio prompts
- System prompts now guide voice selection and text processing, not content generation

### 2. Improved OpenAI TTS Integration

**Problem**: The `/internal/audiobook/chapter` endpoint was using placeholder implementation with fake audio data.

**Solution**:
- Replaced placeholder implementation with actual OpenAI TTS API calls
- Added proper error handling and validation
- Implemented token usage tracking for TTS operations
- Added comprehensive logging for debugging and monitoring

### 3. Enhanced Voice Selection Logic

**New Features**:
- `AudioPromptService.getRecommendedVoice()`: Selects appropriate OpenAI voice based on:
  - Target age group (toddlers, children, adults)
  - System prompt content (emotional, professional, etc.)
  - Language preferences
- Voice mapping:
  - **Toddlers/Children**: `alloy` (clear) or `nova` (expressive)
  - **Emotional storytelling**: `fable` (expressive)
  - **Adults**: `onyx` (authoritative)
  - **Default**: `nova` (general storytelling)

### 4. Intelligent Speed Adjustment

**New Features**:
- `AudioPromptService.getRecommendedSpeed()`: Adjusts TTS speed based on:
  - Target age (slower for children, faster for adults)
  - Audio prompt instructions
  - Environment configuration
- Speed ranges: 0.25 to 4.0 (OpenAI TTS limits)

### 5. Production-Ready Error Handling

**Improvements**:
- Comprehensive input validation
- Graceful fallbacks for missing audio prompts
- Detailed error logging with context
- Token usage tracking with error handling
- Proper HTTP status codes and error responses

## API Changes

### Enhanced Request Parameters

The `/internal/audiobook/chapter` endpoint now accepts:

```json
{
  "storyId": "string (required)",
  "chapterNumber": "number (required)", 
  "chapterContent": "string (required)",
  "storyTitle": "string (optional)",
  "voice": "string (optional - overrides recommendations)",
  "language": "string (optional - defaults to story language)"
}
```

### Enhanced Response Format

```json
{
  "success": true,
  "chapterNumber": 1,
  "audioUrl": "https://storage.googleapis.com/...",
  "duration": 180,
  "format": "mp3",
  "provider": "openai",
  "voice": "nova",
  "metadata": {
    "totalWords": 250,
    "generatedAt": "2025-06-21T...",
    "model": "tts-1",
    "speed": 0.9,
    "storyLanguage": "en-US",
    "textLength": 1234
  }
}
```

## Configuration

### Environment Variables

The system uses these environment variables:

- `TTS_PROVIDER`: `openai` or `vertex` (default: `openai`)
- `TTS_MODEL`: OpenAI TTS model (default: `tts-1`)
- `TTS_VOICE`: Default voice (default: `nova`)
- `TTS_SPEED`: Default speed (default: `0.9`)
- `TTS_LANGUAGE`: Default language (default: `en-US`)
- `OPENAI_API_KEY`: Required for OpenAI TTS

### Audio Prompt Files

Audio prompts are loaded from `src/prompts/audio/{language}.json`:

```json
{
  "systemPrompt": "You are a professional American storyteller for {{story-target-age}}. You speak passionately and with a lot of emotion. You are fun and funny.",
  "language": "en-US",
  "languageName": "English (American)",
  "targetAgeOptions": ["toddlers", "children", "young adults", "adults"],
  "instructions": [
    "Use proper punctuation for natural pauses",
    "Speak expressively and emotionally",
    "Maintain an appropriate pace for the target age",
    "Use varied intonation to maintain interest",
    "Pronounce all words clearly with American accent"
  ]
}
```

## Text Processing Improvements

### Smart Text Enhancement

The `enhanceTextForTTS()` method now:

1. **Adds emotional pauses**: Inserts pauses after exclamations and quoted speech for emotional delivery
2. **Improves pronunciation**: Enhances difficult words and contractions
3. **Maintains clean text**: Removes system instructions from spoken content
4. **Preserves meaning**: Keeps original narrative intact

### Example Processing

**Input**: `"Hello!" she said excitedly...`

**Enhanced**: `"Hello!" she said excitedly... ` (with strategic spacing for pauses)

## Token Usage Tracking

TTS operations are now tracked with:

```json
{
  "authorId": "user-123",
  "storyId": "story-456", 
  "action": "audio_generation",
  "aiModel": "tts-1",
  "inputTokens": 1234,
  "outputTokens": 0,
  "inputPromptJson": {
    "chapterNumber": 1,
    "chapterText": "First 500 chars...",
    "voice": "nova",
    "speed": 0.9,
    "provider": "openai",
    "model": "tts-1",
    "storyLanguage": "en-US"
  }
}
```

## Performance Optimizations

1. **Audio prompt caching**: Prompts are cached in memory to avoid repeated file reads
2. **Efficient text processing**: Minimal text transformations for better performance
3. **Smart truncation**: Text is truncated at sentence boundaries to stay within TTS limits
4. **Async processing**: All operations are properly async for better throughput

## Testing and Validation

### Manual Testing

Test the endpoint with:

```bash
curl -X POST http://localhost:8080/audio/internal/audiobook/chapter \
  -H "Content-Type: application/json" \
  -d '{
    "storyId": "test-story-123",
    "chapterNumber": 1,
    "chapterContent": "Once upon a time, in a magical forest...",
    "storyTitle": "The Magical Adventure"
  }'
```

### Expected Behavior

1. Audio prompt loaded based on story language
2. Voice and speed recommendations applied
3. Text enhanced for better TTS pronunciation
4. Real audio generated via OpenAI TTS
5. Audio uploaded to cloud storage
6. Token usage tracked
7. Comprehensive response returned

## Monitoring and Debugging

### Key Log Messages

- `'Internal API: Generating chapter audio from HTML'`: Request received
- `'Applying audio prompt configuration'`: Audio prompts loaded successfully
- `'Applied audio prompt recommendations'`: Voice/speed recommendations applied
- `'Generating TTS with OpenAI'`: OpenAI TTS call started
- `'OpenAI TTS generation completed'`: Audio generated successfully
- `'TTS token usage recorded'`: Usage tracking completed

### Error Scenarios

1. **Missing OpenAI API Key**: Returns 500 with clear error message
2. **Invalid parameters**: Returns 400 with validation errors
3. **Story not found**: Returns 404 with story ID
4. **TTS API failure**: Returns 500 with OpenAI error details
5. **Storage failure**: Returns 500 with storage error details

## Security Considerations

1. **API Key Protection**: OpenAI API key is loaded from environment variables
2. **Input Validation**: All inputs are validated before processing
3. **Error Sanitization**: Error messages don't expose sensitive information
4. **Storage Security**: Audio files are uploaded with proper content types

## Migration Notes

### Breaking Changes

1. **Response format**: Added new metadata fields
2. **Audio prompt handling**: System prompts no longer included in spoken text
3. **Voice selection**: May change from previous defaults based on recommendations

### Backward Compatibility

- All existing parameters are still supported
- Default behavior maintained when audio prompts are unavailable
- Graceful fallbacks for missing configurations

## Future Improvements

1. **Google Cloud TTS Integration**: Complete Vertex AI TTS implementation
2. **Voice Cloning**: Support for custom voice models
3. **Streaming Audio**: Real-time audio generation for large texts
4. **Multi-language Support**: Enhanced language detection and voice mapping
5. **Quality Controls**: Audio quality validation and enhancement
