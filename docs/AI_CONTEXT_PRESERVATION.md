# AI Context Preservation for Story Generation

This implementation provides context preservation across multiple AI requests during story generation, supporting both Google Vertex AI and OpenAI providers.

## Overview

The context preservation system maintains conversation history and story context throughout the story generation process, ensuring consistent character development, plot continuity, and coherent narrative flow.

## Key Components

### 1. Context Manager (`src/ai/context-manager.ts`)
- **Purpose**: Central manager for storing and retrieving conversation context
- **Features**:
  - In-memory context storage (can be extended to Redis/database)
  - Provider-specific context data (Vertex cachedContent, OpenAI responseId)
  - Conversation history tracking
  - Automatic cleanup of old contexts

### 2. Enhanced AI Providers
- **Vertex AI** (`src/ai/providers/vertex/text.ts`): Supports Google's Context Cache for efficient context management
- **OpenAI** (`src/ai/providers/openai/text.ts`): Maintains conversation history through message arrays

### 3. Story Context Service (`src/services/story-context.ts`)
- **Purpose**: High-level service for story generation with context awareness
- **Features**:
  - Story session management
  - Context-aware outline generation
  - Context-aware chapter generation
  - System prompt generation from story details

## How It Works

### Context Flow
```
1. Initialize Session
   ├── Load story details from database
   ├── Create system prompt with story context
   ├── Initialize context manager
   └── Initialize AI provider context

2. Generate Outline
   ├── Create outline prompt
   ├── Send to AI with contextId
   ├── Store response in context history
   └── Return outline

3. Generate Chapters (for each chapter)
   ├── Create chapter prompt
   ├── Send to AI with contextId (includes previous context)
   ├── Store response in context history
   └── Return chapter content

4. Cleanup
   ├── Clear AI provider context
   └── Clear context manager data
```

### Provider-Specific Implementation

#### Google Vertex AI
- Uses `cachedContent` for efficient context management
- Stores conversation history in context manager
- Builds prompts with conversation history

#### OpenAI
- Uses message arrays for conversation history
- Maintains context through the chat completion API
- No special API calls needed for context management

## Usage Examples

### Basic Story Generation with Context
```typescript
import { StoryContextService } from '@/services/story-context.ts';
import { AIGateway } from '@/ai/gateway.js';

const storyContextService = new StoryContextService();
const aiGateway = AIGateway.fromEnvironment();

// Initialize session
const session = await storyContextService.initializeStorySession(
  'story-123',
  'run-456',
  aiGateway
);

// Generate outline (establishes story context)
const outline = await storyContextService.generateOutline(
  session,
  'Create an exciting adventure with character development'
);

// Generate chapters (uses previous context)
const chapter1 = await storyContextService.generateChapter(
  session,
  1,
  'The Beginning',
  outline
);

const chapter2 = await storyContextService.generateChapter(
  session,
  2,
  'The Adventure Continues',
  outline
);

// Cleanup
await storyContextService.cleanupSession(session);
```

### Direct AI Provider Usage with Context
```typescript
import { AIGateway } from '@/ai/gateway.js';
import { contextManager } from '@/ai/context-manager.js';

const aiGateway = AIGateway.fromEnvironment();
const textService = aiGateway.getTextService();
const contextId = 'story-123-run-456';

// Initialize context
await contextManager.initializeContext(
  contextId,
  'story-123',
  'System prompt with story details...'
);

if (textService.initializeContext) {
  await textService.initializeContext(contextId, systemPrompt);
}

// Make requests with context
const response1 = await textService.complete(
  'Generate story outline',
  { contextId, maxTokens: 2048 }
);

const response2 = await textService.complete(
  'Write chapter 1 based on the outline',
  { contextId, maxTokens: 4096 }
);

// Cleanup
if (textService.clearContext) {
  await textService.clearContext(contextId);
}
await contextManager.clearContext(contextId);
```

## Configuration

### Environment Variables
The context system uses the existing AI provider configuration:

```env
# Provider selection
TEXT_PROVIDER=vertex  # or 'openai'

# Google Vertex AI
GOOGLE_CLOUD_PROJECT_ID=your-project-id
VERTEX_AI_LOCATION=us-central1
VERTEX_AI_MODEL_ID=gemini-2.0-flash

# OpenAI
OPENAI_API_KEY=your-openai-api-key
```

### Context Manager Settings
The context manager can be configured with:
- **Max Age**: Automatic cleanup of old contexts (default: 24 hours)
- **Storage Backend**: Currently in-memory, can be extended to Redis/database

## Integration with Workflow Handlers

The workflow handlers in `src/workflows/handlers.ts` have been updated to use context preservation:

### StoryOutlineHandler
- Initializes story session with context
- Generates outline using story context
- Maintains context for subsequent chapter generation

### ChapterWritingHandler
- Reuses existing context if available
- Generates chapters with full story context
- Maintains consistency across chapters

## Benefits

1. **Consistency**: Characters, plot points, and story elements remain consistent across all generated content
2. **Efficiency**: Reduces redundant context in each request
3. **Quality**: AI has full story context for better narrative coherence
4. **Flexibility**: Works with both Google Vertex AI and OpenAI
5. **Scalability**: Context manager can be extended to persistent storage

## Future Enhancements

1. **Persistent Storage**: Extend context manager to use Redis or database
2. **Context Compression**: Implement smart context trimming for long stories
3. **Provider Optimization**: Use provider-specific context features (e.g., Vertex cachedContent API)
4. **Context Analytics**: Track context usage and effectiveness
5. **Multi-Model Support**: Support different models for different story elements

## Testing

Run the example to see context preservation in action:

```typescript
import { storyExample } from '@/examples/story-generation-example.js';

// Generate a story with context
await storyExample.generateStoryWithContext('story-123', 'run-456');

// Demonstrate context preservation
await storyExample.demonstrateContextPreservation('demo-story', 'demo-run');
```

## Troubleshooting

### Common Issues

1. **Context Not Found**: Ensure context is initialized before making requests
2. **Token Limits**: Long contexts may hit provider token limits - implement context trimming
3. **Memory Usage**: In-memory storage may not be suitable for high-volume usage
4. **Provider Errors**: Check provider-specific error handling and retry logic

### Debugging

Enable debug logging to see context operations:
```typescript
import { logger } from '@/config/logger.js';
logger.level = 'debug';
```

### Monitoring Context Usage
```typescript
import { contextManager } from '@/ai/context-manager.js';

const stats = contextManager.getStats();
console.log('Context Statistics:', stats);
```
