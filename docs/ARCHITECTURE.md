# Story Generation Workflow - Architecture

## Overview

The Story Generation Workflow (SGW) is a provider-agnostic microservice that orchestrates the complete story generation process using Google Cloud Workflows, AI services (Vertex AI, OpenAI, Stability AI), and Cloud Storage. It implements a clean architecture pattern with environment-agnostic business logic and swappable adapters for external services.

## System Architecture

```mermaid
graph TB
    User[User] --> WebApp[Mythoria WebApp]
    WebApp --> DB[(PostgreSQL Database)]
    WebApp --> PubSub[Google Cloud Pub/Sub]
    
    PubSub --> Workflows[Google Cloud Workflows]
    Workflows --> SGW[Story Generation Workflow Service]
    
    SGW --> AI[AI Gateway]
    AI --> Vertex[Vertex AI]
    AI --> OpenAI[OpenAI API]
    AI --> Stability[Stability AI]
    
    SGW --> Storage[Google Cloud Storage]
    SGW --> DB
    
    subgraph "SGW Internal Components"
        Gateway[AI Gateway]
        Internal[Internal API]
        Routes[Route Handlers]
        Adapters[Service Adapters]
        Shared[Shared Business Logic]
    end
```

## Workflow Process

The story generation follows a 5-step orchestrated workflow:

```mermaid
sequenceDiagram
    participant User
    participant WebApp
    participant DB as PostgreSQL
    participant PubSub
    participant WF as Cloud Workflows
    participant SGW as Story-Gen-Workflow
    participant AI as AI Services
    participant GCS as Cloud Storage

    User->>WebApp: POST /stories (title, prompt)
    WebApp->>DB: INSERT stories (status=queued)
    WebApp->>DB: INSERT story_generation_runs (status=queued)
    WebApp-->>User: 202 Accepted + storyId
    WebApp->>PubSub: publish story.requested {storyId,runId}

    PubSub->>WF: event trigger → start execution

    Note over WF,SGW: Step 1: Initialize Run
    WF->>SGW: PATCH /internal/runs/{runId} (running, generate_outline)
    
    Note over WF,AI: Step 2: Generate Story Outline
    WF->>SGW: POST /ai/text/outline
    SGW->>AI: Generate story structure and synopsis
    AI-->>SGW: Structured outline JSON
    SGW-->>WF: Outline response
    WF->>SGW: POST /internal/runs/{runId}/outline (save outline)

    Note over WF,AI: Step 3: Write Chapters (Parallel)
    WF->>SGW: PATCH /internal/runs/{runId} (write_chapters)
    
    loop FOR EACH chapter (parallel execution)
        WF->>SGW: POST /ai/text/chapter/{n}
        SGW->>AI: Generate chapter content + image prompts
        AI-->>SGW: Chapter markdown with prompts
        SGW-->>WF: Chapter response
        WF->>SGW: POST /internal/runs/{runId}/chapter/{n} (save chapter)
    end

    Note over WF,AI: Step 4: Generate Images (Parallel)
    WF->>SGW: PATCH /internal/runs/{runId} (generate_images)
    
    loop FOR EACH chapter (parallel execution)
        WF->>SGW: POST /ai/image
        SGW->>AI: Generate illustration from prompt
        AI-->>SGW: Image data (base64/URL)
        SGW->>GCS: Upload image to storage
        GCS-->>SGW: Storage URI
        SGW-->>WF: Image response
        WF->>SGW: POST /internal/runs/{runId}/chapter/{n}/image (save URI)
    end

    Note over WF,SGW: Step 5: Final Assembly
    WF->>SGW: PATCH /internal/runs/{runId} (assemble)
    WF->>SGW: POST /internal/assemble/{runId}
    SGW->>SGW: Generate HTML/PDF formats
    
    opt Audio Generation (Optional)
        WF->>SGW: POST /internal/tts/{runId}
        SGW->>AI: Generate narration audio
    end

    WF->>SGW: PATCH /internal/runs/{runId} (completed)
    WF-->>PubSub: (optional) publish story.completed
```

## Component Architecture

### 1. AI Gateway (`/src/ai/`)

**Provider-Agnostic AI Service Abstraction**

The AI Gateway implements a facade pattern that abstracts different AI providers behind common interfaces:

```mermaid
classDiagram
    class AIGateway {
        +createTextService() ITextGenerationService
        +createImageService() IImageGenerationService
        +fromEnvironment() AIGateway
    }
    
    class ITextGenerationService {
        <<interface>>
        +complete(prompt, options) Promise~string~
        +generateStructured(prompt, schema) Promise~T~
    }
    
    class IImageGenerationService {
        <<interface>>
        +generate(prompt, options) Promise~ImageResult~
    }
    
    AIGateway --> ITextGenerationService
    AIGateway --> IImageGenerationService
    
    class VertexTextService {
        +complete(prompt, options)
        +generateStructured(prompt, schema)
    }
    
    class OpenAITextService {
        +complete(prompt, options)
        +generateStructured(prompt, schema)
    }
    
    class VertexImageService {
        +generate(prompt, options)
    }
    
    class OpenAIImageService {
        +generate(prompt, options)
    }
    
    class StabilityImageService {
        +generate(prompt, options)
    }
    
    ITextGenerationService <|.. VertexTextService
    ITextGenerationService <|.. OpenAITextService
    IImageGenerationService <|.. VertexImageService
    IImageGenerationService <|.. OpenAIImageService
    IImageGenerationService <|.. StabilityImageService
```

**Environment Configuration:**
```bash
TEXT_PROVIDER=vertex|openai
IMAGE_PROVIDER=vertex|openai|stability
```

### 2. Internal API Endpoints (`/src/routes/internal.ts`)

**Database Operations & Run Management**

| Endpoint | Method | Purpose | Database Operation |
|----------|--------|---------|-------------------|
| `/internal/runs/:runId` | PATCH | Update run status/step | UPDATE story_generation_runs |
| `/internal/runs/:runId/outline` | POST | Save story outline | UPDATE stories SET outline |
| `/internal/runs/:runId/chapter/:chapterNum` | POST | Save chapter content | INSERT/UPDATE chapters |
| `/internal/runs/:runId/chapter/:chapterNum/image` | POST | Save image URI | UPDATE chapters SET image_url |

### 3. AI API Endpoints (`/src/routes/ai.ts`)

**AI Gateway Integration**

| Endpoint | Method | Purpose | AI Provider |
|----------|--------|---------|-------------|
| `/ai/text/outline` | POST | Generate story outline | Text Generation Service |
| `/ai/text/chapter/:chapterNum` | POST | Generate chapter content | Text Generation Service |
| `/ai/image` | POST | Generate illustrations | Image Generation Service |

### 4. Context Management System

**AI Context Preservation**

```mermaid
graph LR
    Context[Context Manager] --> Memory[In-Memory Store]
    Context --> Provider[Provider Data]
    
    subgraph "Provider Integration"
        Vertex[Vertex AI<br/>Cached Content]
        OpenAI[OpenAI<br/>Response Threads]
    end
    
    Provider --> Vertex
    Provider --> OpenAI
    
    Context --> Conversation[Conversation History]
    Conversation --> System[System Messages]
    Conversation --> User[User Messages]
    Conversation --> Assistant[Assistant Responses]
```

## Project Structure

```
src/
├── config/           # Environment and configuration management
│   ├── database.ts   # Database connection setup
│   ├── environment.ts # Environment validation
│   └── logger.ts     # Winston logging configuration
├── shared/           # Environment-agnostic business logic
│   ├── interfaces/   # TypeScript interfaces and types
│   ├── models/       # Data models and schemas
│   └── utils/        # Pure utility functions
├── adapters/         # External service implementations
│   ├── database/     # Database adapters (Drizzle ORM)
│   ├── storage/      # Cloud Storage adapters
│   └── ai/          # AI service adapters
├── ai/              # AI Gateway and providers
│   ├── gateway.ts   # Main AI Gateway facade
│   ├── providers/   # Provider implementations
│   └── context-manager.ts # Context preservation
├── routes/          # Express route handlers
│   ├── health.ts    # Health check endpoints
│   ├── ai.ts        # AI Gateway endpoints
│   └── internal.ts  # Internal workflow endpoints
├── workflows/       # Google Cloud Workflows handlers
└── db/             # Database schema (shared with mythoria-webapp)
```

## Architecture Principles

### 1. **Single Dockerfile** per microservice
- Distroless base image for security
- Multi-stage builds for optimization
- Reproducible builds using `npm ci`

### 2. **Environment-agnostic logic** in `shared/`
- Pure business logic without external dependencies
- Easy unit testing with mocks
- Clear separation of concerns

### 3. **Interface-based adapters** for external services
- Swappable implementations (database, Google Cloud, AI providers)
- Dependency injection pattern
- Provider-agnostic AI services

### 4. **Observability and Monitoring**
- Structured JSON logging with Winston
- Health check endpoints with dependency checks
- Error tracking and performance metrics
- Context preservation for AI interactions

## Data Flow

### Story Generation Run States

```mermaid
stateDiagram-v2
    [*] --> queued
    queued --> running : Workflow starts
    running --> generate_outline : Step 1
    generate_outline --> write_chapters : Step 2
    write_chapters --> generate_images : Step 3
    generate_images --> assemble : Step 4
    assemble --> tts : Step 5 (optional)
    tts --> completed : Success
    assemble --> completed : Skip TTS
    
    generate_outline --> failed : Error
    write_chapters --> failed : Error
    generate_images --> failed : Error
    assemble --> failed : Error
    tts --> tts_failed : TTS Error
    tts_failed --> completed : Continue without audio
    
    running --> cancelled : User cancellation
    
    completed --> [*]
    failed --> [*]
    cancelled --> [*]
```

## Security Architecture

### Authentication & Authorization
- Google Cloud IAM for service-to-service communication
- OIDC tokens for Cloud Run authentication
- Principle of least privilege for service accounts

### Data Protection
- Encrypted data in transit (HTTPS/TLS)
- Encrypted data at rest (Google Cloud Storage)
- Input validation with Zod schemas
- SQL injection prevention with Drizzle ORM

### Security Headers
- Helmet.js middleware for security headers
- CORS policy configuration
- Rate limiting (future enhancement)

## Performance Considerations

### Parallel Processing
- Chapter writing executes in parallel (1-N chapters)
- Image generation executes in parallel per chapter
- Google Cloud Workflows native parallel execution

### Caching Strategy
- AI context preservation between requests
- Provider-specific caching (Vertex AI cached content, OpenAI response threads)
- Database connection pooling

### Resource Optimization
- Cloud Run automatic scaling
- Memory-efficient streaming for large responses
- Lazy loading of AI providers

## Error Handling Strategy

### Workflow-Level Error Handling
```yaml
# Google Cloud Workflows error handling
try:
  steps:
    # All workflow steps
except:
  as: error
  steps:
    - logError:
        call: http.request
        args:
          url: ${baseUrl + "/internal/runs/" + runId}
          method: PATCH
          body:
            status: "failed"
            error_message: ${error.message}
    - reraise: ${error}
```

### Application-Level Error Handling
- Structured error responses with error codes
- Retry mechanisms for transient failures
- Graceful degradation for optional features (TTS)
- Comprehensive logging for debugging

## Deployment Architecture

### Google Cloud Services
- **Cloud Run**: Container hosting with automatic scaling
- **Cloud Workflows**: Orchestration engine
- **Cloud Storage**: Asset and content storage
- **Secret Manager**: Secure configuration management
- **Cloud Build**: CI/CD pipeline

### Environment Separation
- **Development**: Local Docker with `.env` files
- **Staging**: Cloud Run with shared secrets
- **Production**: Cloud Run with production secrets and monitoring
