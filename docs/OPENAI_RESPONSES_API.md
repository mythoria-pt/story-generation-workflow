# OpenAI Responses API Integration

This document describes the updated OpenAI integration using the new Responses API format.

## Overview

The OpenAI providers have been updated to use the new Responses API format as shown in the example configuration. This provides better integration with modern OpenAI capabilities including image generation with enhanced control.

## Configuration

### Environment Variables

Add the following to your `.env` file:

```bash
# OpenAI Configuration
OPEN_AI_API_KEY=your-openai-api-key
TEXT_PROVIDER=openai
IMAGE_PROVIDER=openai
OPENAI_IMAGE_MODEL=dall-e-3
OPENAI_IMAGE_QUALITY=low  # Options: low, standard, high
```

### OpenAI Text Service

The text service now uses the Responses API format:

```typescript
const textService = new OpenAITextService({
  apiKey: process.env.OPEN_AI_API_KEY,
  model: 'gpt-4.1',
  useResponsesAPI: true
});

const response = await textService.complete('Your prompt here', {
  temperature: 1,
  maxTokens: 2048,
  contextId: 'optional-context-id'
});
```

### OpenAI Image Service

The image service has been updated to use the Responses API:

```typescript
const imageService = new OpenAIImageService({
  apiKey: process.env.OPEN_AI_API_KEY,
  model: 'dall-e-3'
});

const imageBuffer = await imageService.generate('Your image prompt', {
  width: 1024,
  height: 1024
});
```

The service automatically uses the `OPENAI_IMAGE_QUALITY` environment variable for quality settings.

## Image Styles

A comprehensive image styles configuration has been added at `src/prompts/imageStyles.json`. This includes detailed prompts for each graphical style available in the database:

### Available Styles

- `cartoon` - Vibrant, stylized cartoon illustrations
- `realistic` - Highly detailed, photorealistic images
- `watercolor` - Soft, flowing watercolor paintings
- `digital_art` - Modern digital artwork
- `hand_drawn` - Authentic hand-drawn illustrations
- `minimalist` - Clean, simple compositions
- `vintage` - Nostalgic artwork with aged textures
- `comic_book` - Dynamic comic book style illustrations
- `anime` - Japanese anime-style artwork
- `pixar_style` - 3D animated Pixar-style characters
- `disney_style` - Classic Disney animation style
- `sketch` - Loose, expressive sketches
- `oil_painting` - Rich oil painting artwork
- `colored_pencil` - Traditional colored pencil techniques

### Using Image Styles

```typescript
import { PromptService } from '@/services/prompt.js';

// Get all available styles
const styles = await PromptService.getAvailableImageStyles();

// Get specific style configuration
const cartoonStyle = await PromptService.getImageStylePrompt('cartoon');

// Use the style in your prompt
const enhancedPrompt = `${cartoonStyle.style}, your scene description here`;
```

## Request Format

The new Responses API uses this format:

```typescript
{
  model: "gpt-4.1",
  input: [
    {
      "role": "system",
      "content": [
        {
          "type": "input_text",
          "text": "System prompt here"
        }
      ]
    },
    {
      "role": "user", 
      "content": [
        {
          "type": "input_text",
          "text": "User prompt here"
        }
      ]
    }
  ],
  text: {
    "format": {
      "type": "text"
    }
  },
  reasoning: {},
  temperature: 1,
  max_output_tokens: 2048,
  top_p: 1,
  store: true
}
```

For image generation, tools are added:

```typescript
{
  // ... other fields
  tools: [
    {
      "type": "image_generation",
      "size": "1024x1024",
      "quality": "low", // From OPENAI_IMAGE_QUALITY env var
      "output_format": "jpeg",
      "background": "auto",
      "moderation": "low",
      "partial_images": 1
    }
  ]
}
```

## Testing

Run the integration test:

```bash
npx tsx scripts/test-openai-integration.ts
```

This will test:
- Text generation with Responses API
- Image styles loading
- Image generation configuration (without actually generating to save credits)

## Best Practices

### Image Prompting

Based on AI image generation best practices:

1. **Use detailed, descriptive language** for better results
2. **Include style references** using the provided image styles
3. **Reference artistic styles** for consistent results
4. **Use technical specifications** like lighting and composition details

### Quality Settings

- `low` - Faster generation, lower cost
- `standard` - Balanced quality and speed  
- `high` - Best quality, higher cost

Adjust `OPENAI_IMAGE_QUALITY` based on your needs and budget.

## Migration

If migrating from the old OpenAI integration:

1. Update environment variables to include `OPENAI_IMAGE_QUALITY`
2. Services will automatically use the new API format
3. No code changes required for existing service usage
4. Image styles are now available via `PromptService`

## Troubleshooting

### Common Issues

1. **API Key Issues**: Ensure `OPEN_AI_API_KEY` is set correctly
2. **Model Access**: Verify your OpenAI account has access to `gpt-4.1` and `dall-e-3`
3. **Rate Limits**: The new API may have different rate limits
4. **Response Format**: The response structure has changed, but this is handled automatically

### Debug Logging

Enable detailed logging:

```bash
DEBUG_AI_FULL_PROMPTS=true
DEBUG_AI_FULL_RESPONSES=true
LOG_LEVEL=debug
```
