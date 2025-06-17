# TTS API Test Examples

This file contains example requests for testing the TTS functionality.

## Environment Setup

Make sure you have the following environment variables set:

```bash
# Required for OpenAI TTS
OPENAI_API_KEY=your_openai_api_key_here

# Optional TTS configuration
TTS_PROVIDER=openai
TTS_MODEL=tts-1
TTS_VOICE=nova
TTS_SPEED=0.9
TTS_LANGUAGE=en-US
```

## Test TTS Generation

### 1. Generate TTS for an existing story run

```bash
curl -X POST "http://localhost:8080/internal/tts/{runId}" \
  -H "Content-Type: application/json"
```

Replace `{runId}` with an actual run ID from your database.

### 2. Example Response

```json
{
  "success": true,
  "runId": "story-run-123",  "result": {
    "audioUrls": {
      "1": "https://storage.googleapis.com/mythoria-story-assets/story-id-123/audio/chapter_1.mp3",
      "2": "https://storage.googleapis.com/mythoria-story-assets/story-id-123/audio/chapter_2.mp3",
      "3": "https://storage.googleapis.com/mythoria-story-assets/story-id-123/audio/chapter_3.mp3"
    },
    "totalDuration": 540,
    "format": "mp3",
    "provider": "openai",
    "voice": "nova",
    "metadata": {
      "totalWords": 450,
      "generatedAt": "2025-06-17T10:30:00.000Z",
      "model": "tts-1",
      "speed": 0.9
    }
  },
  "step": "tts"
}
```

## Voice Options Test

Test different voices by setting the `TTS_VOICE` environment variable:

### OpenAI Voice Options

```bash
# Young and energetic (default)
TTS_VOICE=nova

# British accent, great for storytelling
TTS_VOICE=fable

# Neutral and balanced
TTS_VOICE=alloy

# Deep and dramatic
TTS_VOICE=onyx

# Bright and upbeat
TTS_VOICE=shimmer

# Male, authoritative
TTS_VOICE=echo
```

## Speed Options Test

Test different speaking speeds:

```bash
# Slower for younger children
TTS_SPEED=0.7

# Standard speed
TTS_SPEED=0.9

# Normal speed
TTS_SPEED=1.0

# Faster for adults
TTS_SPEED=1.2
```

## Language-Specific Tests

The system will automatically use the appropriate language prompt based on the story's language setting.

### Portuguese Story (pt-PT)
- Uses Portuguese storyteller prompt
- Emphasizes Portuguese pronunciation
- Avoids Brazilian expressions

### English Stories
- **en-US**: American storyteller
- **en-GB**: British storyteller

### Other Supported Languages
- **fr-FR**: French storyteller
- **es-ES**: Spanish storyteller
- **de-DE**: German storyteller
- **it-IT**: Italian storyteller

## Error Testing

### Test Missing API Key
```bash
# Remove or invalid API key
unset OPENAI_API_KEY
# Should fallback to placeholder implementation
```

### Test Unsupported Language
```bash
# System should fallback to English
# No special configuration needed - handled automatically
```

### Test Provider Fallback
```bash
# Set Vertex AI as provider (not fully implemented)
TTS_PROVIDER=vertex
# Should fallback to OpenAI if available
```

## Integration Testing

### Complete Story Workflow with TTS

1. **Create a story** (mythoria-webapp)
2. **Start story generation workflow**
3. **Generate outline**
4. **Write chapters** 
5. **Generate images**
6. **Generate TTS** ← Test this step
7. **Assemble final story**

### Check TTS Integration

```bash
# Check if TTS was generated
curl "http://localhost:8080/internal/runs/{runId}" \
  -H "Content-Type: application/json"

# Look for "tts" step in the response
```

## Performance Testing

### Estimate Processing Time

- **Short story** (100 words): ~5-10 seconds
- **Medium story** (500 words): ~10-20 seconds  
- **Long story** (1000+ words): ~20-40 seconds

Processing time depends on:
- OpenAI API response time
- Text length and complexity
- Network latency
- Storage upload time

### Monitor Resource Usage

```bash
# Check logs for TTS processing
grep "TTS" application.log

# Monitor API usage
# Check OpenAI dashboard for usage statistics
```

## Quality Assurance

### Audio Quality Checklist

1. **Clarity**: Words are clearly pronounced
2. **Pace**: Appropriate speed for target age
3. **Emotion**: Storytelling tone is engaging
4. **Pauses**: Natural breaks between sentences
5. **Flow**: Smooth transitions between chapters

### Language Quality Checklist

1. **Accent**: Correct regional pronunciation
2. **Grammar**: Proper language structure
3. **Cultural**: Appropriate expressions
4. **Age**: Suitable vocabulary for target age

## Troubleshooting

### Common Issues

#### "OpenAI client not initialized"
```bash
# Check API key
echo $OPENAI_API_KEY

# Set API key
export OPENAI_API_KEY="your-key-here"
```

#### "Audio prompt not found"
```bash
# Check available languages
ls src/prompts/audio/

# Verify language code format
# Use: en-US, pt-PT, fr-FR, etc.
# Not: en, pt, fr
```

#### "TTS synthesis failed"
```bash
# Check OpenAI API status
curl -H "Authorization: Bearer $OPENAI_API_KEY" \
  "https://api.openai.com/v1/models"

# Check text length (OpenAI has limits)
# Maximum: ~4096 characters per request
```

### Debug Mode

Enable detailed logging:

```bash
LOG_LEVEL=debug
```

Then check logs for detailed TTS processing information.
