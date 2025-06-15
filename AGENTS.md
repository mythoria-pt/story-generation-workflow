# AGENTS.md - AI Coding Agent Context

## Project Overview

**Service Name**: `story-generation-workflow`  
**Version**: 0.1.0  
**Type**: Google Cloud Run Microservice  
**Parent Project**: Mythoria AI Storytelling Platform  
**Purpose**: Provider-agnostic orchestration service for AI-powered story generation

This is a production-ready Node.js TypeScript microservice that orchestrates complete story generation workflows using Google Cloud services and multiple AI providers. The service follows clean architecture principles with environment-agnostic business logic and comprehensive observability.

## Core Architecture Principles

### 1. **Clean Architecture Implementation**
- **`src/shared/`**: Pure business logic without external dependencies
- **`src/adapters/`**: Swappable implementations for external services  
- **`src/ai/`**: Provider-agnostic AI gateway with multiple provider support
- **Interface-based design**: All external dependencies are abstracted behind interfaces

### 2. **Provider-Agnostic AI Services**
- **Text Generation**: Vertex AI, OpenAI (configurable via environment)
- **Image Generation**: Vertex AI, OpenAI DALL-E, Stability AI
- **Factory Pattern**: `AIGateway.fromEnvironment()` creates services based on env vars
- **Context Preservation**: Maintains conversation state across AI interactions

### 3. **Google Cloud Workflows Integration**
- **Orchestration**: Complex multi-step workflows managed by Google Cloud Workflows
- **Parallel Processing**: Chapter writing and image generation execute concurrently
- **Error Handling**: Comprehensive retry logic and graceful degradation
- **Observability**: Full logging and monitoring throughout workflow execution

## Technology Stack & Dependencies

### Core Runtime
```json
{
  "node": "20+",
  "typescript": "5.7.2",
  "target": "ES2022",
  "modules": "ESNext",
  "strict": true
}
```

### Framework & Middleware
- **Express.js 4.21.2**: Web framework with async route handlers
- **Helmet**: Security middleware (CORS, headers, etc.)
- **Winston**: Structured JSON logging with multiple transports
- **Zod**: Runtime type validation and schema parsing

### Database & ORM
- **Drizzle ORM 0.43.1**: Type-safe database operations with PostgreSQL
- **Shared Schema**: Database schema imported from `../mythoria-webapp/drizzle/schema.ts`
- **Migration Strategy**: Migrations managed by parent webapp service

### Google Cloud SDKs
```typescript
// Primary Google Cloud integrations
import { VertexAI } from '@google-cloud/aiplatform';
import { Storage } from '@google-cloud/storage';
import { WorkflowsServiceV1 } from '@google-cloud/workflows';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
```

### AI Provider SDKs
- **OpenAI 4.77.0**: Chat completions, DALL-E, structured outputs
- **Vertex AI**: Gemini models, Imagen, cached content API
- **Stability AI**: Image generation via REST API

### Development & Testing
- **TSX**: Development server with hot reload
- **Jest + ts-jest**: Unit and integration testing
- **ESLint**: TypeScript-specific linting rules
- **Docker**: Multi-stage builds with distroless base images

## Project Structure & Module Organization

```
src/
├── config/                    # Configuration & Environment Management
│   ├── database.ts           # Drizzle connection with pooling
│   ├── environment.ts        # Zod-based env validation
│   └── logger.ts            # Winston structured logging setup
├── shared/                   # Pure Business Logic (No External Dependencies)
│   ├── interfaces/          
│   │   ├── ai.ts           # ITextGenerationService, IImageGenerationService
│   │   ├── database.ts     # IDatabaseAdapter interface
│   │   └── workflow.ts     # Workflow state and step interfaces
│   ├── models/             # Zod schemas and data models
│   │   ├── story.ts        # Story outline, chapter schemas
│   │   └── workflow.ts     # Run state, error schemas
│   └── utils/              # Pure utility functions
├── adapters/                # External Service Implementations
│   ├── database/
│   │   └── drizzle.ts      # DrizzleDatabaseAdapter implementation
│   ├── storage/
│   │   └── gcs.ts          # Google Cloud Storage adapter
│   └── ai/                 # AI provider adapters (if needed)
├── ai/                      # AI Gateway & Provider Implementations
│   ├── gateway.ts          # Main AIGateway facade class
│   ├── context-manager.ts  # Conversation context preservation
│   └── providers/          # Provider-specific implementations
│       ├── vertex/
│       │   ├── text.ts     # VertexTextService
│       │   └── image.ts    # VertexImageService
│       ├── openai/
│       │   ├── text.ts     # OpenAITextService (with Responses API)
│       │   └── image.ts    # OpenAIImageService (DALL-E)
│       └── stability/
│           └── image.ts    # StabilityImageService
├── routes/                  # Express Route Handlers
│   ├── health.ts           # Health checks with dependency validation
│   ├── ai.ts              # AI Gateway endpoints (/ai/text/*, /ai/image)
│   └── internal.ts         # Workflow internal APIs (/internal/runs/*)
├── workflows/              # Workflow-related handlers
├── db/                     # Database Schema (Imported from webapp)
│   └── index.ts           # Re-exports from ../mythoria-webapp/drizzle/
├── types/                  # TypeScript type definitions
├── examples/               # Example requests and usage
├── prompts/               # AI prompt templates
└── index.ts               # Application entry point with middleware setup
```

## Coding Standards & Conventions

### TypeScript Configuration
```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true
  }
}
```

### Naming Conventions
- **Classes**: `PascalCase` (e.g., `StoryGenerationService`, `VertexTextService`)
- **Functions/Variables**: `camelCase` (e.g., `generateStoryOutline`, `contextManager`)
- **Constants**: `SCREAMING_SNAKE_CASE` (e.g., `MAX_RETRY_ATTEMPTS`, `DEFAULT_MODEL`)
- **Interfaces**: `PascalCase` with `I` prefix (e.g., `ITextGenerationService`)
- **Types**: `PascalCase` (e.g., `WorkflowStep`, `StoryOutline`)
- **Files**: `kebab-case` for multi-word files (e.g., `context-manager.ts`)

### Function Design Patterns
```typescript
// Pure functions when possible
export const formatChapterTitle = (chapterNumber: number, title: string): string => {
  return `Chapter ${chapterNumber}: ${title}`;
};

// Async functions with comprehensive error handling
export const generateChapterContent = async (
  request: ChapterRequest
): Promise<ChapterResponse> => {
  const logger = createContextLogger({ storyId: request.storyId, chapter: request.chapter });
  
  try {
    logger.info('Chapter generation started');
    
    const result = await aiGateway.generateStructuredText(
      createChapterPrompt(request),
      chapterResponseSchema
    );
    
    logger.info('Chapter generation completed', { 
      wordCount: result.content.length 
    });
    
    return result;
  } catch (error) {
    logger.error('Chapter generation failed', { error });
    throw new WorkflowError(
      'Failed to generate chapter content',
      'CHAPTER_GENERATION_FAILED',
      'write_chapters',
      true // retryable
    );
  }
};
```

### Error Handling Strategy
```typescript
// Custom error classes with workflow context
export class WorkflowError extends Error {
  constructor(
    message: string,
    public code: string,
    public step: string,
    public retryable: boolean = false,
    public metadata?: Record<string, any>
  ) {
    super(message);
    this.name = 'WorkflowError';
  }
}

// Async error boundaries for Express routes
export const asyncHandler = (
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>
) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
```

## AI Integration Patterns

### Provider Factory Pattern
```typescript
// Environment-based provider selection
export class AIGateway {
  static fromEnvironment(): AIGateway {
    const textProvider = process.env.TEXT_PROVIDER; // 'vertex' | 'openai'
    const imageProvider = process.env.IMAGE_PROVIDER; // 'vertex' | 'openai' | 'stability'
    
    return new AIGateway(
      this.createTextService(textProvider),
      this.createImageService(imageProvider)
    );
  }
  
  private static createTextService(provider: string): ITextGenerationService {
    switch (provider) {
      case 'vertex':
        return new VertexTextService({
          projectId: process.env.GOOGLE_CLOUD_PROJECT_ID!,
          location: process.env.VERTEX_AI_LOCATION!,
          model: process.env.VERTEX_AI_MODEL_ID!
        });
      case 'openai':
        return new OpenAITextService({
          apiKey: process.env.OPENAI_API_KEY!,
          model: 'gpt-4o',
          useResponsesAPI: true // New OpenAI Responses API
        });
      default:
        throw new Error(`Unsupported text provider: ${provider}`);
    }
  }
}
```

### Context Preservation System
```typescript
// AI context management for conversation continuity
export class ContextManager {
  private contexts = new Map<string, ConversationContext>();
  
  async initializeContext(
    contextId: string, 
    storyId: string, 
    systemPrompt: string
  ): Promise<void> {
    const context: ConversationContext = {
      storyId,
      conversationHistory: [
        { role: 'system', content: systemPrompt, step: 'init' }
      ],
      providerData: {}, // Provider-specific cache data
      createdAt: new Date(),
      lastUsedAt: new Date()
    };
    
    this.contexts.set(contextId, context);
  }
  
  async addConversationEntry(
    contextId: string,
    role: 'user' | 'assistant',
    content: string,
    step: string
  ): Promise<void> {
    const context = this.getContext(contextId);
    if (!context) throw new Error(`Context ${contextId} not found`);
    
    context.conversationHistory.push({ role, content, step });
    context.lastUsedAt = new Date();
  }
}
```

## Database Patterns & Schema

### Shared Database Architecture
```typescript
// Import shared schema from parent webapp
import { stories, storyGenerationRuns, chapters } from '../mythoria-webapp/drizzle/schema.js';
import { drizzle } from 'drizzle-orm/postgres-js';

// Database adapter with connection pooling
export class DrizzleDatabaseAdapter implements IDatabaseAdapter {
  constructor(private db: ReturnType<typeof drizzle>) {}
  
  async updateStoryGenerationRun(
    runId: string, 
    updates: Partial<StoryGenerationRun>
  ): Promise<void> {
    await this.db
      .update(storyGenerationRuns)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(storyGenerationRuns.id, runId));
  }
}
```

### Type-Safe Database Operations
```typescript
// Use Drizzle's type inference for database operations
export const saveChapterContent = async (
  db: DrizzleDB,
  runId: string,
  chapterData: ChapterContentRequest
): Promise<void> => {
  await db.transaction(async (tx) => {
    // Update chapter content
    await tx
      .update(chapters)
      .set({
        content: chapterData.content,
        imagePrompts: chapterData.imagePrompts,
        updatedAt: new Date()
      })
      .where(
        and(
          eq(chapters.storyId, chapterData.storyId),
          eq(chapters.chapterNumber, chapterData.chapterNumber)
        )
      );
    
    // Update run progress
    await tx
      .update(storyGenerationRuns)
      .set({
        currentStep: 'generate_images',
        updatedAt: new Date()
      })
      .where(eq(storyGenerationRuns.id, runId));
  });
};
```

## Testing Strategy & Patterns

### Test Structure
```
src/tests/
├── unit/                   # Unit tests for individual components
│   ├── ai/
│   │   ├── gateway.test.ts
│   │   └── providers/
│   ├── shared/
│   │   └── utils.test.ts
│   └── adapters/
├── integration/            # Integration tests with real services
│   ├── ai-providers.test.ts
│   └── workflow.test.ts
├── mocks/                  # Mock implementations
│   ├── ai-services.ts
│   └── database.ts
├── fixtures/               # Test data and fixtures
├── setup.ts               # Jest setup and global mocks
└── helpers/               # Test utility functions
```

### Mock Strategy
```typescript
// AI provider mocks for testing
export class MockTextService implements ITextGenerationService {
  async complete(prompt: string, options?: CompletionOptions): Promise<string> {
    // Return predictable mock responses based on prompt content
    if (prompt.includes('outline')) {
      return JSON.stringify({
        title: 'Mock Adventure Story',
        synopsis: 'A brave hero embarks on a magical journey',
        chapters: [
          { title: 'The Beginning', summary: 'Hero starts journey' },
          { title: 'The Challenge', summary: 'Hero faces obstacles' }
        ]
      });
    }
    
    return `Mock response for: ${prompt.substring(0, 50)}...`;
  }
  
  async generateStructured<T>(prompt: string, schema: ZodSchema<T>): Promise<T> {
    // Generate valid mock data that matches the schema
    const mockData = this.generateMockData(schema);
    return schema.parse(mockData);
  }
}
```

### Integration Test Patterns
```typescript
// Integration tests with real AI providers (rate-limited)
describe('AI Provider Integration', () => {
  let aiGateway: AIGateway;
  
  beforeAll(() => {
    // Only run integration tests if API keys are available
    if (!process.env.VERTEX_AI_PROJECT_ID && !process.env.OPENAI_API_KEY) {
      console.log('Skipping integration tests - no API keys provided');
      return;
    }
    
    aiGateway = AIGateway.fromEnvironment();
  });
  
  it('should generate story outline with real AI provider', async () => {
    const request: OutlineRequest = {
      storyId: 'integration-test',
      prompt: 'A short story about friendship',
      genre: 'children'
    };
    
    const result = await aiGateway.generateStructuredText(
      'Generate a story outline...',
      storyOutlineSchema
    );
    
    expect(result.title).toBeDefined();
    expect(result.chapters).toHaveLength.toBeGreaterThan(0);
  }, 30000); // Extended timeout for AI requests
});
```

## Environment Configuration & Secrets

### Environment Variable Schema
```typescript
// Comprehensive environment validation with Zod
export const environmentSchema = z.object({
  // Application
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  
  // Database (shared with mythoria-webapp)
  DB_HOST: z.string().min(1),
  DB_USER: z.string().min(1).default('mythoria_user'),
  DB_PASSWORD: z.string().min(1),
  DB_NAME: z.string().min(1).default('mythoria'),
  DB_PORT: z.coerce.number().default(5432),
  DB_SSL_MODE: z.enum(['disable', 'require']).default('require'),
  
  // Google Cloud
  GOOGLE_CLOUD_PROJECT_ID: z.string().min(1),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  
  // AI Provider Selection
  TEXT_PROVIDER: z.enum(['vertex', 'openai']).default('vertex'),
  IMAGE_PROVIDER: z.enum(['vertex', 'openai', 'stability']).default('vertex'),
  
  // Vertex AI
  VERTEX_AI_LOCATION: z.string().default('europe-west9'),
  VERTEX_AI_MODEL_ID: z.string().default('gemini-2.0-flash'),
  VERTEX_AI_OUTLINE_MODEL: z.string().optional(),
  
  // OpenAI (optional)
  OPENAI_API_KEY: z.string().optional(),
  
  // Stability AI (optional)
  STABILITY_API_KEY: z.string().optional(),
  
  // Storage
  STORAGE_BUCKET_NAME: z.string().min(1),
  
  // Workflows
  WORKFLOWS_LOCATION: z.string().default('europe-west9')
});

export type Environment = z.infer<typeof environmentSchema>;
```

### Secret Management Pattern
```typescript
// Production secrets via Google Secret Manager
// Development secrets via .env files
export const loadEnvironment = (): Environment => {
  // Load from .env in development
  if (process.env.NODE_ENV !== 'production') {
    dotenv.config();
  }
  
  try {
    return environmentSchema.parse(process.env);
  } catch (error) {
    logger.error('Environment validation failed', { error });
    process.exit(1);
  }
};
```

## Google Cloud Workflows Integration

### Workflow Definition Structure
```yaml
# workflows/story-generation.yaml
main:
  params: [event]
  steps:
    - init:
        assign:
          - payload: ${json.decode(base64.decode(event.data))}
          - storyId: ${payload.storyId}
          - runId: ${payload.runId}
          - baseUrl: "https://story-generation-workflow-XXX.run.app"
    
    - runPipeline:
        try:
          steps:
            - markRunStarted: # PATCH /internal/runs/{runId}
            - genOutline:     # POST /ai/text/outline  
            - saveOutline:    # POST /internal/runs/{runId}/outline
            - writeChaptersParallel: # Parallel chapter generation
            - generateImagesParallel: # Parallel image generation
            - assembleStory:  # POST /internal/assemble/{runId}
            - optionalTTS:    # POST /internal/tts/{runId}
        except:
          as: error
          steps:
            - logError:       # PATCH /internal/runs/{runId} (failed status)
            - reraise: ${error}
```

### Workflow Handler Pattern
```typescript
// Route handlers that interface with Google Cloud Workflows
export const handleOutlineGeneration = asyncHandler(async (req: Request, res: Response) => {
  const { storyId, runId, prompt } = req.body;
  const logger = createContextLogger({ storyId, runId, step: 'generate_outline' });
  
  logger.info('Starting outline generation');
  
  try {
    // Generate outline using AI Gateway
    const outline = await aiGateway.generateStructuredText(
      createOutlinePrompt(prompt),
      storyOutlineSchema
    );
    
    // Return structured response for workflow
    res.json({
      success: true,
      storyId,
      runId,
      outline,
      timestamp: new Date().toISOString()
    });
    
    logger.info('Outline generation completed');
  } catch (error) {
    logger.error('Outline generation failed', { error });
    throw new WorkflowError(
      'Failed to generate story outline',
      'OUTLINE_GENERATION_FAILED',
      'generate_outline',
      true
    );
  }
});
```

## Performance & Observability

### Structured Logging
```typescript
// Context-aware logging throughout the application
export const createContextLogger = (context: {
  storyId: string;
  runId?: string;
  step?: string;
  provider?: string;
}) => {
  return logger.child(context);
};

// Usage in services
const contextLogger = createContextLogger({ 
  storyId: request.storyId, 
  runId: request.runId,
  step: 'write_chapters',
  provider: 'vertex'
});

contextLogger.info('Chapter generation started', { 
  chapter: request.chapterNumber,
  wordCount: request.targetWordCount 
});
```

### Request Timing & Metrics
```typescript
// Performance monitoring middleware
export const performanceMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const start = process.hrtime.bigint();
  
  res.on('finish', () => {
    const duration = Number(process.hrtime.bigint() - start) / 1_000_000; // Convert to ms
    
    logger.info('Request completed', {
      method: req.method,
      url: req.url,
      status: res.statusCode,
      duration,
      userAgent: req.get('user-agent')
    });
  });
  
  next();
};
```

## Security & Best Practices

### Input Validation
```typescript
// Comprehensive input validation with Zod
export const validateStoryRequest = (input: unknown): StoryRequest => {
  const schema = z.object({
    storyId: z.string().uuid('Story ID must be a valid UUID'),
    prompt: z.string()
      .min(10, 'Prompt must be at least 10 characters')
      .max(2000, 'Prompt must not exceed 2000 characters'),
    genre: z.enum(['fantasy', 'adventure', 'mystery', 'scifi']).optional(),
    targetAudience: z.enum(['children', 'young_adult', 'adult']).optional(),
    chapters: z.number().min(1).max(10).default(5)
  });
  
  try {
    return schema.parse(input);
  } catch (error) {
    throw new ValidationError('Invalid story request', error.errors);
  }
};
```

### Security Headers & Middleware
```typescript
// Express security configuration
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

// CORS configuration for production
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? ['https://mythoria.com', 'https://app.mythoria.com']
    : true,
  credentials: true
}));
```

## Development Workflow & Commands

### Essential Commands
```bash
# Development
npm run dev              # Start with hot reload (tsx)
npm run build           # TypeScript compilation
npm run start           # Production server

# Testing  
npm test                # Run all tests
npm run test:watch      # Watch mode
npm run test:coverage   # Coverage report
npm run test:integration # Integration tests only

# Code Quality
npm run lint            # ESLint check
npm run lint:fix        # Fix linting issues  
npm run type-check      # TypeScript check

# Database
npm run db:check        # Verify database connection
npm run db:studio       # Open Drizzle Studio (read-only)

# Environment
npm run env:validate    # Validate environment variables

# Docker
npm run docker:build    # Build container
npm run docker:run      # Run container locally

# Google Cloud
npm run gcp:deploy      # Deploy to Cloud Run
npm run gcp:logs        # View service logs
```

### Development Guidelines for AI Agents

1. **Always validate environment first**: Run `npm run env:validate` before starting development
2. **Use type-safe database operations**: Import types from shared schema
3. **Follow the adapter pattern**: Never directly import external service SDKs in business logic
4. **Add comprehensive logging**: Include context (storyId, runId, step) in all log entries
5. **Write tests for new features**: Unit tests for business logic, integration tests for AI providers
6. **Handle AI provider errors gracefully**: Implement retry logic and fallback strategies
7. **Use structured responses**: All API endpoints should return consistent JSON structures
8. **Validate all inputs**: Use Zod schemas for request validation
9. **Document new environment variables**: Update the environment schema and documentation
10. **Test with multiple providers**: Ensure AI Gateway works with different provider configurations

This service is designed to be highly maintainable, observable, and extensible. When adding new features, follow the established patterns and maintain the separation of concerns between business logic, adapters, and external services.
story-generation-workflow/
├── src/
│   ├── config/           # Environment and configuration management
│   ├── shared/           # Environment-agnostic business logic and interfaces
│   ├── adapters/         # External service implementations (swappable with mocks)
│   ├── workflows/        # Google Cloud Workflows definitions and handlers
│   ├── db/              # Database schema (shared with mythoria-webapp)
│   ├── routes/          # Express route handlers
│   ├── tests/           # Test setup and utilities
│   └── index.ts         # Application entry point
├── docs/                # Documentation
├── scripts/             # Deployment and utility scripts
├── drizzle/             # Database migrations
├── Dockerfile           # Container definition
├── cloudbuild.yaml      # Google Cloud Build configuration
└── package.json         # Dependencies and scripts
```

## Architecture Principles

### Clean Architecture
- **Single Dockerfile** per microservice with distroless base for security
- **Environment-agnostic logic** in `shared/` for easy unit testing
- **Interface-based adapters** for external services (database, Google Cloud)
- **Reproducible builds** using npm ci and locked dependencies

### Code Organization
- `shared/`: Pure business logic, no external dependencies
- `adapters/`: Implementation of external service interfaces
- `config/`: Environment validation and configuration
- `workflows/`: Google Cloud Workflows YAML and handlers

## Key Dependencies

### Production Dependencies
```json
{
  "@google-cloud/storage": "^7.14.0",
  "@google-cloud/vertexai": "^1.10.0", 
  "@google-cloud/workflows": "^4.2.0",
  "drizzle-orm": "^0.43.1",
  "express": "^4.21.2",
  "helmet": "^8.0.0",
  "pg": "^8.16.0",
  "winston": "^3.11.0",
  "zod": "^3.25.0"
}
```

### Development Dependencies
- TypeScript with strict configuration
- Jest with ts-jest for testing
- ESLint with TypeScript rules
- TSX for development server

## Configuration

### TypeScript Configuration
- **Target**: ES2022
- **Module**: ESNext with Node resolution
- **Strict mode**: Enabled with all strict checks
- **Path mapping**: Configured for clean imports (`@/*`)
- **Build output**: `dist/` directory

### Database Configuration
- **ORM**: Drizzle with PostgreSQL dialect
- **Schema**: `./src/db/schema/index.ts`
- **Migrations**: Shared with mythoria-webapp
- **Migration table**: `drizzle_migrations` in public schema

### Docker Configuration
- **Multi-stage build**: Builder + distroless runtime
- **Base image**: `gcr.io/distroless/nodejs20-debian12`
- **Port**: 8080
- **Build strategy**: npm ci for reproducible builds

## Available Scripts

### Development
- `npm run dev` - Start development server with hot reload
- `npm run build` - Build for production
- `npm run start` - Start production server

### Database
- `npm run db:generate` - Generate migrations
- `npm run db:migrate` - Run migrations
- `npm run db:push` - Push schema changes
- `npm run db:studio` - Open Drizzle Studio

### Testing & Quality
- `npm run test` - Run tests
- `npm run test:watch` - Run tests in watch mode
- `npm run test:coverage` - Generate coverage report
- `npm run lint` - Run ESLint
- `npm run lint:fix` - Fix linting issues

### Deployment
- `npm run docker:build` - Build Docker image
- `npm run docker:run` - Run Docker container locally
- `npm run gcp:deploy` - Deploy to Google Cloud Run

## Core Interfaces

### Repository Interfaces
```typescript
interface IStoryRepository {
  findById(id: string): Promise<StoryOutline | null>;
  create(story: Omit<StoryOutline, 'id' | 'createdAt' | 'updatedAt'>): Promise<StoryOutline>;
  update(id: string, updates: Partial<StoryOutline>): Promise<StoryOutline>;
  delete(id: string): Promise<void>;
}
```

### Service Interfaces  
```typescript
interface ITextGenerationService {
  generateStoryOutline(prompt: string): Promise<StoryOutline>;
  generateChapterContent(outline: StoryOutline, chapterNumber: number): Promise<ChapterContent>;
}

interface IImageGenerationService {
  generateImage(prompt: string, style: string): Promise<Buffer>;
}
```

## Core Types

### Story Data Models
```typescript
interface StoryOutline {
  id: string;
  title: string;
  synopsis: string;
  genre: string;
  targetAudience: string;
  chapters: ChapterOutline[];
  createdAt: Date;
  updatedAt: Date;
}

interface ChapterContent {
  id: string;
  chapterNumber: number;
  title: string;
  content: string;
  imagePrompts: ImagePrompt[];
  wordCount: number;
  createdAt: Date;
}
```

## Environment Setup

### Required Environment Variables
- Database connection settings (shared with mythoria-webapp)
- Google Cloud project configuration
- Vertex AI model IDs
- Cloud Storage bucket names
- Authentication credentials

### Environment Validation
- Uses Zod schemas for runtime validation
- Separate development and production configurations
- Validates all required variables on startup

## Testing Strategy

### Test Configuration
- **Framework**: Jest with ts-jest preset
- **Environment**: Node.js
- **Coverage**: Configured for `src/` directory
- **Module mapping**: Supports TypeScript path aliases
- **Setup**: Custom test setup file

### Test Organization
- Unit tests for shared business logic
- Integration tests for adapters
- Mock implementations for external services
- Coverage reporting with HTML output

## Deployment

### Google Cloud Run
- **Platform**: Managed
- **Region**: europe-west9
- **Container**: Built from Dockerfile
- **Build**: Google Cloud Build pipeline

### Security
- **Helmet**: Security headers middleware  
- **Distroless**: Minimal container image
- **Secrets**: Environment-based configuration
- **HTTPS**: Cloud Run default encryption

## Development Guidelines

### Code Style
- TypeScript strict mode enabled
- ESLint with TypeScript rules
- Path aliases for clean imports
- Explicit return types preferred

### Architecture Rules
1. Business logic goes in `shared/` - no external dependencies
2. External services behind interfaces in `adapters/`
3. Configuration validated with Zod schemas
4. Database operations through repository pattern
5. Error handling with structured logging

### Testing Rules
1. Unit test business logic without external dependencies
2. Use mocks for external service adapters
3. Integration tests for database operations
4. Coverage reporting for all source files

This service is part of the larger Mythoria ecosystem and shares database schema with the main webapp while maintaining clear service boundaries and independent deployment capabilities.
