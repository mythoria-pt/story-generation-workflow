# Story Generation Workflow - API Reference

## Overview

The Story Generation Workflow API provides comprehensive endpoints for AI-powered story creation, editing, and management. All endpoints support JSON requests and responses with consistent error handling and authentication.

## Base URL

- **Production**: `https://story-generation-workflow-803421888801.europe-west9.run.app`
- **Development**: `http://localhost:3000`

## Authentication

All API endpoints require JWT authentication in the Authorization header:

```http
Authorization: Bearer <jwt_token>
```

## Core Story API

### Create Story

Generate a new story with AI assistance.

```http
POST /api/stories
```

**Request Body:**
```json
{
  "title": "The Adventure Begins",
  "prompt": "A young explorer discovers an ancient map",
  "genre": "adventure",
  "style": "descriptive",
  "chapters": 5,
  "parameters": {
    "tone": "optimistic",
    "complexity": "intermediate",
    "target_audience": "young_adult"
  }
}
```

**Response:**
```json
{
  "success": true,
  "storyId": "uuid-string",
  "status": "queued",
  "estimatedCompletion": "2025-06-27T15:30:00Z",
  "workflowId": "workflow-execution-id"
}
```

### Get Story

Retrieve a story by its ID.

```http
GET /api/stories/{storyId}
```

**Response:**
```json
{
  "success": true,
  "story": {
    "id": "uuid-string",
    "title": "The Adventure Begins",
    "status": "completed",
    "htmlContent": "<html>...</html>",
    "metadata": {
      "wordCount": 2500,
      "chapters": 5,
      "genre": "adventure",
      "createdAt": "2025-06-27T14:00:00Z",
      "completedAt": "2025-06-27T14:30:00Z"
    },
    "elements": [
      {
        "id": "element-uuid",
        "type": "chapter",
        "sequenceOrder": 1,
        "content": "Chapter 1 content...",
        "status": "completed"
      }
    ]
  }
}
```

### Update Story

Update story details or trigger regeneration.

```http
PUT /api/stories/{storyId}
```

**Request Body:**
```json
{
  "title": "Updated Title",
  "regenerateChapter": 3,
  "parameters": {
    "style": "more_dramatic"
  }
}
```

### Delete Story

Remove a story and all associated content.

```http
DELETE /api/stories/{storyId}
```

**Response:**
```json
{
  "success": true,
  "message": "Story deleted successfully"
}
```

## Story Editing API

### Edit Story

Request AI-powered edits to existing published stories.

```http
POST /api/story-edit
```

**Request Body:**
```json
{
  "storyId": "uuid-string",
  "chapterNumber": 3,
  "userRequest": "Make the dialogue more dramatic and add more suspense to the scene"
}
```

**Response:**
```json
{
  "success": true,
  "storyId": "uuid-string",
  "chapterNumber": 3,
  "context": "Chapter 3",
  "userRequest": "Make the dialogue more dramatic...",
  "updatedHtml": "<html>...</html>",
  "metadata": {
    "originalLength": 1500,
    "editedLength": 1620,
    "htmlLength": 8940,
    "timestamp": "2025-06-27T15:45:00Z"
  }
}
```

**Error Responses:**
- `404`: Story not found
- `400`: Invalid request parameters
- `409`: Story is currently being processed
- `422`: User request exceeds character limit (2000 chars)

## AI Generation API

### Generate Content

Direct AI content generation endpoint.

```http
POST /api/ai/generate
```

**Request Body:**
```json
{
  "type": "text|image|audio",
  "provider": "vertex|openai|stability",
  "prompt": "Generation prompt",
  "parameters": {
    "model": "gemini-2.0-flash",
    "temperature": 0.7,
    "max_tokens": 1000
  }
}
```

**Response:**
```json
{
  "success": true,
  "content": "Generated content or URL",
  "metadata": {
    "provider": "vertex",
    "model": "gemini-2.0-flash",
    "tokens_used": 150,
    "cost": 0.002,
    "generation_time": 2.3
  }
}
```

### AI Provider Status

Check the status and capabilities of AI providers.

```http
GET /api/ai/providers
```

**Response:**
```json
{
  "providers": {
    "vertex": {
      "status": "available",
      "models": ["gemini-2.0-flash", "imagen-3.0"],
      "capabilities": ["text", "image"],
      "latency": 1.2,
      "error_rate": 0.01
    },
    "openai": {
      "status": "available",
      "models": ["gpt-4", "dall-e-3", "tts-1"],
      "capabilities": ["text", "image", "audio"],
      "latency": 2.1,
      "error_rate": 0.02
    }
  }
}
```

## Image Editing API

### Edit Images

AI-powered image editing and enhancement.

```http
POST /api/images/edit
```

**Request Body:**
```json
{
  "storyId": "uuid-string",
  "imageUrl": "gs://bucket/path/to/image.png",
  "userRequest": "Make the sky more dramatic with storm clouds"
}
```

**Parameters:**
- **storyId** (required): UUID of the story containing the image
- **imageUrl** (required): Google Cloud Storage URL of the image to edit
- **userRequest** (required): Natural language description of desired changes (1-2000 characters)

**Response:**
```json
{
  "success": true,
  "storyId": "uuid-string",
  "originalImageUrl": "gs://bucket/path/to/original_image.png",
  "newImageUrl": "https://storage.googleapis.com/bucket/path/to/image_v2.png",
  "userRequest": "Make the sky more dramatic with storm clouds",
  "metadata": {
    "originalImageSize": 1024000,
    "editedImageSize": 1100000,
    "filename": "chapter_1_v2_2025-06-27T16-00-00-000Z.png",
    "timestamp": "2025-06-27T16:00:00.000Z"
  }
}
```

**Error Responses:**
- `404`: Story or image not found
- `400`: Invalid image URL format
- `422`: User request exceeds character limit
- `500`: Image editing failed

## Translation API

### Translate Story (Async)

Translate the entire story (all chapters) into a new locale. This preserves chapter HTML structure and translates chapter titles, synopsis, plot description, and the main story title. Dedication message is not translated. The story's `storyLanguage` is updated only if all chapter translations succeed.

```http
POST /api/jobs/translate-text
```

**Request Body:**
```json
{
  "storyId": "uuid-string",
  "targetLocale": "en-US | en-GB | pt-PT | pt-BR | es-ES | fr-FR | it-IT | de-DE | nl-NL | pl-PL"
}
```

**Response:**
```json
{
  "success": true,
  "jobId": "uuid-string",
  "estimatedDuration": 180000,
  "message": "Translation job created successfully"
}
```

Use `GET /api/jobs/{jobId}` to retrieve status and results.

**Job Result (on completion):**
```json
{
  "success": true,
  "type": "full_story_translation",
  "storyId": "uuid",
  "targetLocale": "pt-PT",
  "updatedChapters": [
    { "chapterNumber": 1, "titleTranslated": "...", "htmlLengthBefore": 1200, "htmlLengthAfter": 1215 },
    { "chapterNumber": 2, "error": "..." }
  ],
  "totalChapters": 6,
  "successfulTranslations": 5,
  "failedTranslations": 1,
  "metadataUpdated": false,
  "timestamp": "2025-08-19T12:00:00Z"
}
```

**Validation & Errors:**
- `400`: Target locale equals current story language
- `404`: Story not found
- `500`: Translation job creation failed

## Text-to-Speech API

### Generate Audio

Convert text to high-quality speech.

```http
POST /api/tts/generate
```

**Request Body:**
```json
{
  "text": "Once upon a time, in a land far away...",
  "voice": "nova|alloy|echo|fable|onyx|shimmer",
  "format": "mp3|wav|opus",
  "speed": 1.0,
  "chapterNumber": 1
}
```

**Response:**
```json
{
  "success": true,
  "audioUrl": "https://storage.googleapis.com/bucket/audio.mp3",
  "metadata": {
    "duration": 45.2,
    "voice": "nova",
    "format": "mp3",
    "size": 724800,
    "provider": "openai"
  }
}
```

### Generate TTS for Story

Generate audio narration for an entire story.

```http
POST /api/internal/tts/{runId}
```

**Response:**
```json
{
  "success": true,
  "runId": "story-run-123",
  "result": {
    "audioUrls": {
      "1": "https://storage.googleapis.com/bucket/audio/chapter_1.mp3",
      "2": "https://storage.googleapis.com/bucket/audio/chapter_2.mp3",
      "3": "https://storage.googleapis.com/bucket/audio/chapter_3.mp3"
    },
    "totalDuration": 540,
    "format": "mp3",
    "provider": "openai",
    "voice": "nova",
    "metadata": {
      "totalWords": 450,
      "generatedAt": "2025-06-27T16:00:00.000Z",
      "model": "tts-1",
      "speed": 0.9
    }
  }
}
```

### Voice Options

Available voice options for TTS generation:

| Voice | Description | Best For |
|-------|-------------|----------|
| `nova` | Young and energetic | Children's stories, adventure tales |
| `fable` | British accent, storytelling | Fantasy, classic literature |
| `alloy` | Neutral and balanced | General purpose, educational content |
| `onyx` | Deep and dramatic | Thrillers, dramatic narratives |
| `shimmer` | Bright and upbeat | Comedy, light-hearted stories |
| `echo` | Male, authoritative | Documentary style, serious topics |

### Speed Options

Configure narration speed:

- `0.7` - Slower, suitable for younger children
- `0.9` - Standard storytelling speed
- `1.0` - Normal conversational speed
- `1.2` - Faster pace for adults

## Workflow Management API

### Get Workflow Status

Check the status of story generation workflows.

```http
GET /api/workflows/{workflowId}
```

**Response:**
```json
{
  "success": true,
  "workflow": {
    "id": "workflow-execution-id",
    "status": "running|completed|failed",
    "progress": {
      "current_step": "generate_chapters",
      "total_steps": 5,
      "completed_steps": 3,
      "percentage": 60
    },
    "steps": [
      {
        "name": "create_outline",
        "status": "completed",
        "duration": 2.1,
        "output": "Story outline generated"
      },
      {
        "name": "generate_chapters",
        "status": "running",
        "progress": 75,
        "estimated_completion": "2025-06-27T16:05:00Z"
      }
    ]
  }
}
```

### Cancel Workflow

Stop a running workflow execution.

```http
DELETE /api/workflows/{workflowId}
```

**Response:**
```json
{
  "success": true,
  "message": "Workflow cancelled successfully",
  "status": "cancelled"
}
```

## Health and Monitoring

### Health Check

Service health and status endpoint.

```http
GET /api/health
```

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2025-06-27T16:00:00Z",
  "version": "0.1.0",
  "services": {
    "database": "healthy",
    "ai_providers": "healthy",
    "storage": "healthy",
    "workflows": "healthy"
  },
  "metrics": {
    "uptime": 86400,
    "active_workflows": 5,
    "total_stories": 1250
  }
}
```

### Service Metrics

Get detailed service performance metrics.

```http
GET /api/metrics
```

**Response:**
```json
{
  "performance": {
    "average_response_time": 250,
    "requests_per_minute": 45,
    "error_rate": 0.02,
    "active_connections": 12
  },
  "ai_usage": {
    "total_tokens_today": 125000,
    "cost_today": 12.50,
    "provider_distribution": {
      "vertex": 0.6,
      "openai": 0.3,
      "stability": 0.1
    }
  },
  "stories": {
    "completed_today": 23,
    "average_generation_time": 180,
    "queue_length": 3
  }
}
```

## Error Handling

### Standard Error Response

All endpoints return consistent error responses:

```json
{
  "success": false,
  "error": {
    "code": "STORY_NOT_FOUND",
    "message": "The requested story could not be found",
    "details": {
      "storyId": "invalid-uuid",
      "timestamp": "2025-06-27T16:00:00Z"
    }
  }
}
```

### Common Error Codes

| Code | Description | HTTP Status |
|------|-------------|-------------|
| `INVALID_REQUEST` | Request validation failed | 400 |
| `UNAUTHORIZED` | Authentication required | 401 |
| `FORBIDDEN` | Insufficient permissions | 403 |
| `STORY_NOT_FOUND` | Story does not exist | 404 |
| `CONFLICT` | Resource conflict | 409 |
| `VALIDATION_ERROR` | Input validation failed | 422 |
| `RATE_LIMITED` | Too many requests | 429 |
| `INTERNAL_ERROR` | Server error | 500 |
| `SERVICE_UNAVAILABLE` | Service temporarily unavailable | 503 |

## Rate Limiting

- **Default Limit**: 100 requests per minute per user
- **Burst Limit**: 200 requests in a 5-minute window
- **Headers**: Rate limit information included in response headers

```http
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1625097600
```

## Webhooks

### Webhook Events

Configure webhooks to receive notifications for story events:

- `story.created` - New story initiated
- `story.completed` - Story generation finished
- `story.failed` - Story generation failed
- `story.updated` - Story modified
- `audio.generated` - Audio narration completed

### Webhook Payload

```json
{
  "event": "story.completed",
  "timestamp": "2025-06-27T16:00:00Z",
  "data": {
    "storyId": "uuid-string",
    "userId": "user-uuid",
    "title": "The Adventure Begins",
    "status": "completed",
    "metadata": {
      "wordCount": 2500,
      "chapters": 5,
      "generationTime": 180
    }
  }
}
```

---

**API Version**: 1.0.0  
**Last Updated**: June 27, 2025  
**OpenAPI Specification**: Available at `/api/docs`
