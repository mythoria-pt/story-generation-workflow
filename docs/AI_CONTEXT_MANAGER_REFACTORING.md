# AI Context Manager Refactoring

## Overview
This document summarizes the refactoring of the AI Context Manager to work with the new stateful conversation APIs from OpenAI Responses and Google GenAI.

## Changes Made

### 1. Simplified Context Manager (`src/ai/context-manager.ts`)

**Removed:**
- `ConversationEntry` interface - no longer needed since conversations are handled by the APIs
- `conversationHistory` array - manual conversation tracking is obsolete
- `addConversationEntry()` method - providers handle conversation history internally
- `getConversationMessages()` method - not needed with stateful APIs

**Kept:**
- `ContextData` interface - simplified to store system prompt and provider-specific data
- `ProviderContextData` interface - updated to store only necessary identifiers
- Context lifecycle methods (`initializeContext`, `clearContext`, `updateProviderData`)
- Cleanup and statistics methods

**Updated:**
- Provider-specific data now stores:
  - OpenAI: `responseId` for stateful conversation continuity
  - Google GenAI: `chatInstance` for the Chat object from `ai.chats.create()`

### 2. OpenAI Provider (`src/ai/providers/openai/text.ts`)

**Changes:**
- Removed manual conversation history building
- Uses OpenAI Responses API stateful conversations with `previous_response_id`
- Only sends system prompt on first request
- Stores and uses `responseId` for conversation continuity
- No longer manually tracks user/assistant messages

### 3. Google GenAI Provider (`src/ai/providers/google-genai/text.ts`)

**Changes:**
- Updated to use Google GenAI Chat instances for stateful conversations
- `initializeContext()` now creates a Chat instance with `startChat()`
- Stores Chat instance in context manager
- Uses existing Chat instance for subsequent requests (stateful)
- Falls back to stateless generation if no Chat instance exists

**Key improvements:**
- Leverages `systemInstruction` parameter for system prompts
- Chat instances automatically maintain conversation history
- Simplified prompt handling

### 4. Updated Tests (`src/tests/context-preservation.test.ts`)

**Changes:**
- Removed tests for conversation history management
- Removed tests for `addConversationEntry` and `getConversationMessages`
- Updated provider data tests to match new structure
- Added test for context cleanup functionality
- Fixed import paths

### 5. Test Setup (`src/tests/setup.ts`)

**Changes:**
- Removed `@google-cloud/vertexai` mock since Vertex AI is no longer used
- Kept other necessary mocks for test environment

## Benefits

### 1. Reduced Complexity
- Eliminated ~100 lines of redundant conversation history management code
- Simplified context data structure
- Removed manual message tracking logic

### 2. Better API Utilization
- **OpenAI Responses API**: Uses native stateful conversations with `previous_response_id`
- **Google GenAI**: Uses Chat instances that maintain context automatically
- Both APIs handle conversation history internally, reducing memory usage

### 3. Improved Performance
- No more manual conversation history reconstruction
- Reduced network overhead (no need to send full conversation history)
- Lower memory footprint

### 4. Better Reliability
- Conversation state is maintained by the AI providers themselves
- Less chance of context corruption or loss
- Simplified error handling

## Migration Notes

### For Developers
- The Context Manager API has been simplified but remains backward compatible for basic operations
- `addConversationEntry()` and `getConversationMessages()` methods have been removed
- Provider-specific data structure has changed - update any direct access to these fields

### For Existing Code
- Any code that directly called `addConversationEntry()` should be updated
- Code that accessed `conversationHistory` should be refactored
- The `initializeContext()` method signature remains the same

## Example Usage

```typescript
// Initialize context (unchanged)
await contextManager.initializeContext(contextId, storyId, systemPrompt);

// For OpenAI - the response_id is automatically stored and used
const openaiResponse = await textService.complete(prompt, { contextId });

// For Google GenAI - the chat instance maintains state
const googleResponse = await textService.complete(prompt, { contextId });

// Context cleanup (unchanged)
await contextManager.clearContext(contextId);
```

## Testing
All existing tests have been updated and are passing. The refactored system maintains the same external API while being significantly simpler internally.
