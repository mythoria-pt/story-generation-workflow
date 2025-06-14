# OpenAI Responses API Integration

This document describes the integration of OpenAI's new Responses API endpoint (`/v1/responses`) in the story generation workflow, replacing the legacy Chat Completions API (`/v1/chat/completions`).

## Overview

The OpenAI Responses API is a more advanced endpoint that provides:
- Better conversation state management
- Native context preservation via `previous_response_id`
- Support for multimodal interactions
- Enhanced tool calling capabilities
- More structured response objects

## Key Changes

### 1. Endpoint Migration
- **Old**: `https://api.openai.com/v1/chat/completions`
- **New**: `https://api.openai.com/v1/responses`

### 2. Request Format Changes

#### Legacy Chat Completions
```json
{
  "model": "gpt-4o",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant"},
    {"role": "user", "content": "Hello"}
  ],
  "max_tokens": 1000,
  "temperature": 0.7
}
```

#### New Responses API
```json
{
  "model": "gpt-4o",
  "input": "Hello",
  "instructions": "You are a helpful assistant",
  "modalities": ["text"],
  "previous_response_id": "resp_abc123",
  "max_output_tokens": 1000,
  "temperature": 0.7
}
```

### 3. Response Format Changes

#### Legacy Format
```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "Hello! How can I help you?"
      }
    }
  ]
}
```

#### New Format
```json
{
  "id": "resp_67ccd2bed1ec8190b14f964abc0542670bb6a6b452d3795b",
  "object": "response",
  "status": "completed",
  "output": [
    {
      "type": "message",
      "role": "assistant",
      "content": [
        {
          "type": "output_text",
          "text": "Hello! How can I help you?"
        }
      ]
    }
  ]
}
```

## Implementation Details

### Configuration

The OpenAI provider now supports both APIs through configuration:

```typescript
// Environment Variables
OPENAI_API_KEY=your-api-key
OPENAI_USE_RESPONSES_API=true  // Set to false to use legacy API

// Programmatic Configuration
const service = new OpenAITextService({
  apiKey: 'your-api-key',
  model: 'gpt-4o',
  useResponsesAPI: true  // Default: true
});
```

### Context Preservation

The Responses API provides superior context management:

#### Legacy Approach (Chat Completions)
- Context maintained through message arrays
- Full conversation history sent with each request
- No native conversation continuity

#### New Approach (Responses API)
- Context maintained via `previous_response_id`
- Efficient conversation continuity
- Reduced token usage for context

### Code Examples

#### Basic Usage with Context
```typescript
import { OpenAITextService } from '@/ai/providers/openai/text.js';
import { contextManager } from '@/ai/context-manager.js';

const service = new OpenAITextService({
  apiKey: process.env.OPENAI_API_KEY!,
  useResponsesAPI: true
});

const contextId = 'story-123-run-456';

// Initialize context
await contextManager.initializeContext(
  contextId,
  'story-123',
  'You are a creative storyteller...'
);

await service.initializeContext(contextId, 'You are a creative storyteller...');

// Make context-aware requests
const outline = await service.complete(
  'Create a story outline',
  { contextId, maxTokens: 1000 }
);

const chapter1 = await service.complete(
  'Write the first chapter based on the outline',
  { contextId, maxTokens: 2000 }
);

// Context is automatically preserved between requests
```

#### Fallback to Legacy API
```typescript
const legacyService = new OpenAITextService({
  apiKey: process.env.OPENAI_API_KEY!,
  useResponsesAPI: false  // Use Chat Completions
});

// Same interface, different underlying implementation
const response = await legacyService.complete('Hello', { maxTokens: 100 });
```

## Benefits of Responses API

### 1. Improved Context Management
- **Previous**: Manual message array management
- **Now**: Automatic via `previous_response_id`

### 2. Better Performance
- **Previous**: Full conversation history in each request
- **Now**: Efficient context referencing

### 3. Enhanced Features
- Native multimodal support
- Better tool calling
- Structured outputs
- Web search integration (when available)

### 4. Future-Proof
- OpenAI's recommended approach
- Active development and feature additions
- Better alignment with agentic workflows

## Migration Guide

### For Existing Code

1. **Update Configuration**:
   ```env
   # Add to your .env file
   OPENAI_USE_RESPONSES_API=true
   ```

2. **No Code Changes Required**: The interface remains the same, only the underlying implementation changes.

3. **Test Thoroughly**: While the interface is the same, response behavior may vary slightly.

### For New Implementations

Use the Responses API by default:
```typescript
const service = new OpenAITextService({
  apiKey: apiKey,
  useResponsesAPI: true  // Default for new implementations
});
```

## Error Handling

The implementation includes robust error handling with fallback capabilities:

```typescript
try {
  // Responses API request
  const response = await service.complete(prompt, options);
} catch (error) {
  if (error.message.includes('model not supported')) {
    // Automatic fallback to Chat Completions might be implemented
    logger.warn('Falling back to Chat Completions API');
  }
  throw error;
}
```

## Environment Variables

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `OPENAI_API_KEY` | OpenAI API key | Required | `sk-...` |
| `OPENAI_USE_RESPONSES_API` | Use Responses API | `true` | `true`/`false` |

## Testing

Run the example to test both APIs:

```bash
# Build the project
npm run build

# Set your API key
export OPENAI_API_KEY="your-api-key"

# Run the comparison example
node dist/examples/openai-responses-api-example.js
```

The example will:
1. Compare Responses API vs Chat Completions
2. Demonstrate context preservation
3. Show Responses API specific features
4. Test error handling

## Troubleshooting

### Common Issues

1. **Model Not Supported**: Some models may not support the Responses API yet
   - **Solution**: Set `useResponsesAPI: false` for unsupported models

2. **Context Not Preserved**: Previous response ID not being used
   - **Check**: Ensure `contextId` is provided in options
   - **Check**: Verify context manager is properly initialized

3. **Response Format Errors**: Unexpected response structure
   - **Check**: Verify you're using a supported model
   - **Check**: Check API response format in logs

### Debug Logging

Enable debug logging to see API interactions:

```typescript
import { logger } from '@/config/logger.js';
logger.level = 'debug';
```

This will log:
- Request/response details
- Context preservation operations
- Response ID tracking
- Error details

## Performance Considerations

1. **Token Efficiency**: Responses API uses fewer tokens for context
2. **Request Latency**: Similar to Chat Completions
3. **Rate Limits**: Same rate limits apply as Chat Completions
4. **Cost**: Similar pricing, potentially lower due to reduced context tokens

## Future Enhancements

Planned improvements:
1. **Streaming Support**: Add streaming response support
2. **Tool Integration**: Leverage native tool calling
3. **Multimodal**: Add support for image/audio inputs
4. **Advanced Context**: Implement context compression and optimization
