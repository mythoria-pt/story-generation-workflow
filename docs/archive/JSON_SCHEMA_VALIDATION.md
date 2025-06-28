# JSON Schema Validation for Story Outline Generation

## Overview

This update implements JSON schema validation for the story outline generation step to ensure that AI responses are always structured correctly and can be reliably parsed by subsequent workflow steps.

## Changes Made

### 1. JSON Schema Definition

**File:** `src/prompts/schemas/story-outline.json`

Created a comprehensive JSON schema that defines the exact structure expected for story outline responses:

- `bookTitle`: String (1-255 characters)
- `bookCoverPrompt`: String (10-1000 characters) 
- `bookBackCoverPrompt`: String (10-1000 characters)
- `synopses`: String (10-500 characters)
- `chapters`: Array of chapter objects (1-50 items)
  - `chapterNumber`: Integer (1-50)
  - `chapterTitle`: String (1-100 characters)
  - `chapterSynopses`: String (10-300 characters)
  - `chapterPhotoPrompt`: String (10-500 characters)

### 2. Updated AI Provider Interfaces

**File:** `src/ai/interfaces.ts`

Added `jsonSchema?: object` option to `TextGenerationOptions` interface to support structured output.

### 3. Enhanced AI Providers

**Files:** 
- `src/ai/providers/openai/text.ts`
- `src/ai/providers/vertex/text.ts`

Updated both OpenAI and Vertex AI providers to support JSON schema validation:

#### OpenAI Provider:
- **Responses API**: Uses `response_format.json_schema` parameter
- **Chat Completions API**: Uses `response_format.json_schema` parameter

#### Vertex AI Provider:
- Uses `response_format.type: 'json_object'` 
- Adds JSON instruction to prompts when schema is provided

### 4. Schema Service

**File:** `src/services/schema.ts`

Created a utility service for loading and caching JSON schemas:

- `loadSchema(schemaName)`: Loads schema from file system
- Built-in caching to avoid repeated file reads
- Error handling for missing or invalid schemas

### 5. Updated Story Outline Generation

**File:** `src/routes/ai.ts`

Modified the `/generate-outline` endpoint to:

- Load the story outline JSON schema
- Pass schema to AI provider for structured output
- Validate that the response matches expected structure
- Provide better error handling for invalid JSON

### 6. Enhanced Prompt Template

**File:** `src/prompts/en-US/text-outline.json`

Updated the prompt template to:

- Emphasize JSON-only output in system prompt
- Remove markdown code blocks from response format
- Clarify that response must be valid, parseable JSON
- Add explicit structure examples

## Usage

The JSON schema validation is automatically applied when generating story outlines. No changes are needed to existing API calls.

### Example Request:
```http
POST /api/ai/generate-outline
Content-Type: application/json

{
  "storyId": "uuid-here",
  "runId": "uuid-here", 
  "chapterCount": 5,
  "averageAge": 10,
  "storyTone": "engaging"
}
```

### Example Response:
The AI will now be forced to respond with valid JSON matching the schema:

```json
{
  "success": true,
  "storyId": "uuid-here",
  "runId": "uuid-here",
  "outline": {
    "bookTitle": "The Magical Adventure",
    "bookCoverPrompt": "A colorful cartoon illustration showing...",
    "bookBackCoverPrompt": "The back view of the magical forest...",
    "synopses": "A young girl discovers she has magical powers...",
    "chapters": [
      {
        "chapterNumber": 1,
        "chapterTitle": "The Discovery",
        "chapterSynopses": "Luna finds a glowing crystal...",
        "chapterPhotoPrompt": "A cartoon illustration of a girl..."
      }
    ]
  }
}
```

## Benefits

1. **Reliability**: Eliminates parsing errors from malformed AI responses
2. **Consistency**: Ensures all outline responses have the same structure
3. **Validation**: Automatic validation of required fields and data types
4. **Error Handling**: Better error messages when AI fails to follow schema
5. **Provider Agnostic**: Works with both OpenAI and Vertex AI providers
6. **Performance**: Schema caching reduces file system reads

## Testing

Added comprehensive tests in `src/tests/schema.test.ts` to verify:

- Schema loading functionality
- Schema caching behavior
- Validation logic
- Error handling

Run tests with:
```bash
npm test -- schema.test.ts
```

## Environment Variables

No new environment variables are required. The existing AI provider configuration continues to work as before.

## Error Handling

The system now provides specific error messages for JSON parsing failures:

- **Invalid JSON**: "AI generated invalid JSON response"
- **Missing Schema**: "Failed to load schema: [schema-name]"
- **Structure Validation**: "Invalid outline structure received"

## Future Enhancements

This schema validation system can be extended to other workflow steps:

1. Chapter generation validation
2. Image prompt validation  
3. Assembly step validation
4. Custom validation rules per story type
