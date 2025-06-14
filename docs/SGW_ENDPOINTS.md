# Story Generation Workflow - SGW Endpoints Implementation

This document describes the implemented endpoints for the Story Generation Workflow (SGW) service based on the functional design specification.

## Overview

The SGW service implements two main categories of endpoints:

1. **AI Gateway Endpoints** (`/ai/*`) - Provider-agnostic AI services
2. **Internal Endpoints** (`/internal/*`) - Run management and workflow coordination

## AI Gateway Endpoints (`/ai/*`)

### Text Generation

#### `POST /ai/text/outline`

Generate story outline using AI text generation.

**Request Body:**
```json
{
  "storyId": "uuid",
  "runId": "uuid", 
  "prompt": "story request",
  "genre": "fantasy", // optional
  "targetAudience": "children", // optional
  "length": "medium" // optional: short|medium|long
}
```

**Response:**
```json
{
  "success": true,
  "storyId": "uuid",
  "runId": "uuid",
  "outline": {
    "title": "Story Title",
    "genre": "Fantasy",
    "synopsis": "Brief story synopsis",
    "characters": [...],
    "setting": {...},
    "chapters": [...],
    "themes": [...]
  }
}
```

#### `POST /ai/text/chapter/:chapterNumber`

Generate a specific chapter using AI text generation.

**Request Body:**
```json
{
  "storyId": "uuid",
  "runId": "uuid",
  "outline": {
    "title": "Story Title",
    "characters": ["Character 1", "Character 2"],
    "setting": "Fantasy world",
    "plotPoints": ["Event 1", "Event 2"]
  },
  "previousChapters": ["Chapter 1 content..."] // optional
}
```

**Response:**
```json
{
  "success": true,
  "storyId": "uuid",
  "runId": "uuid",
  "chapterNumber": 1,
  "chapter": "Chapter content...",
  "imagePrompts": ["Prompt 1", "Prompt 2"]
}
```

### Image Generation

#### `POST /ai/image`

Generate an image using AI image generation.

**Request Body:**
```json
{
  "prompt": "A magical forest with...",
  "storyId": "uuid", // optional
  "runId": "uuid", // optional
  "chapterNumber": 1, // optional
  "width": 1024, // optional
  "height": 1024, // optional
  "style": "vivid" // optional: vivid|natural
}
```

**Response:**
```json
{
  "success": true,
  "storyId": "uuid",
  "runId": "uuid", 
  "chapterNumber": 1,
  "image": {
    "data": "base64-encoded-image",
    "format": "png",
    "size": 123456
  }
}
```

## Internal Endpoints (`/internal/*`)

### Run Management

#### `PATCH /internal/runs/:runId`

Update run status and metadata.

**Request Body:**
```json
{
  "status": "running", // optional: queued|running|completed|failed|cancelled
  "currentStep": "generate_outline", // optional
  "errorMessage": "Error details", // optional
  "metadata": {} // optional
}
```

**Response:**
```json
{
  "success": true,
  "run": {
    "runId": "uuid",
    "status": "running",
    "currentStep": "generate_outline",
    "startedAt": "2025-06-13T...",
    // ... other run fields
  }
}
```

#### `GET /internal/runs/:runId`

Get run details with steps.

**Response:**
```json
{
  "success": true,
  "run": {
    "runId": "uuid",
    "storyId": "uuid",
    "status": "running",
    "currentStep": "write_chapters",
    // ... other run fields
  },
  "steps": [
    {
      "runId": "uuid",
      "stepName": "generate_outline",
      "status": "completed",
      "detailJson": {...},
      // ... other step fields
    }
  ]
}
```

### Data Storage

#### `POST /internal/runs/:runId/outline`

Store generated outline.

**Request Body:**
```json
{
  "outline": {
    "title": "Story Title",
    "chapters": [...],
    // ... outline structure
  }
}
```

#### `POST /internal/runs/:runId/chapter/:chapterNumber`

Store generated chapter.

**Request Body:**
```json
{
  "chapter": "Chapter content...",
  "imagePrompts": ["Prompt 1", "Prompt 2"] // optional
}
```

#### `POST /internal/runs/:runId/chapter/:chapterNumber/image`

Store generated image for chapter.

**Request Body:**
```json
{
  "imageData": "base64-encoded-image",
  "imageUrl": "https://storage.../image.png", // optional
  "prompt": "Image generation prompt" // optional
}
```

**Response:**
```json
{
  "success": true,
  "runId": "uuid",
  "chapterNumber": 1,
  "imageUrl": "https://storage.../image.png"
}
```

### Final Production

#### `POST /internal/assemble/:runId`

Assemble story into final formats (HTML, PDF).

**Response:**
```json
{
  "success": true,
  "runId": "uuid",
  "result": {
    "files": {
      "html": "https://storage.../story.html",
      "pdf": "https://storage.../story.pdf"
    },
    "metadata": {
      "title": "Story Title",
      "wordCount": 5000,
      "pageCount": 20,
      "generatedAt": "2025-06-13T..."
    }
  }
}
```

#### `POST /internal/tts/:runId`

Generate audio narration for story.

**Response:**
```json
{
  "success": true,
  "runId": "uuid",
  "result": {
    "audioUrl": "https://storage.../narration.mp3",
    "duration": 1200,
    "format": "mp3",
    "metadata": {
      "totalWords": 5000,
      "generatedAt": "2025-06-13T..."
    }
  }
}
```

## AI Provider Configuration

The AI Gateway supports multiple providers configured via environment variables:

### Text Providers
- `TEXT_PROVIDER=vertex` (default) - Google Vertex AI
- `TEXT_PROVIDER=openai` - OpenAI GPT models  
- `TEXT_PROVIDER=azure-openai` - Azure OpenAI

### Image Providers
- `IMAGE_PROVIDER=vertex` (default) - Google Vertex AI Imagen
- `IMAGE_PROVIDER=openai` - OpenAI DALL-E
- `IMAGE_PROVIDER=stability` - Stability AI

### Required Environment Variables

```bash
# Core Configuration
GOOGLE_CLOUD_PROJECT_ID=your-project
GOOGLE_CLOUD_REGION=us-central1
STORAGE_BUCKET_NAME=mythoria-generated-stories

# AI Provider Selection
TEXT_PROVIDER=vertex
IMAGE_PROVIDER=vertex

# Provider Credentials (as needed)
OPENAI_API_KEY=sk-...
AZURE_OPENAI_ENDPOINT=https://...
AZURE_OPENAI_API_KEY=...
STABILITY_API_KEY=sk-...
```

## Architecture Benefits

1. **Provider Agnostic** - Easy to switch between AI providers by changing environment variables
2. **Observable** - All operations update database with progress and results
3. **Resumable** - Workflow can recover from failures using stored state
4. **Loosely Coupled** - Web app publishes to Pub/Sub and polls database for status
5. **Scalable** - Each step can be parallelized as needed

## Error Handling

All endpoints return structured error responses:

```json
{
  "success": false,
  "error": "Error message describing what went wrong"
}
```

HTTP status codes follow REST conventions:
- `200` - Success
- `404` - Resource not found
- `500` - Server error
- `400` - Invalid request

## Next Steps

1. **Workflow Definition** - Create Google Cloud Workflows YAML that orchestrates these endpoints
2. **Database Migrations** - Ensure story generation schema is deployed
3. **Provider Testing** - Test with actual AI provider credentials
4. **Integration Testing** - End-to-end workflow testing
5. **Monitoring** - Add comprehensive logging and metrics
