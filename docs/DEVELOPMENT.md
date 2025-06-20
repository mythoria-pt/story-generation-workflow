# Story Generation Workflow - Development Guide

## Project Overview

The Story Generation Workflow is a Node.js microservice built with TypeScript, Express.js, and Google Cloud services. It follows clean architecture principles with provider-agnostic AI services and comprehensive testing.

## Development Environment Setup

### Prerequisites
- **Node.js**: 20+ (ES Modules required)
- **TypeScript**: 5.7.2
- **Docker**: For containerized development
- **Google Cloud CLI**: For local testing with GCP services
- **PostgreSQL**: Shared database with mythoria-webapp

### Environment Configuration

#### Local Development (.env)
```bash
# Copy template
cp .env.example .env

# Required environment variables
NODE_ENV=development
PORT=3000

# Database (shared with mythoria-webapp)
DB_HOST=localhost
DB_USER=mythoria_user
DB_PASSWORD=your_password
DB_NAME=mythoria
DB_PORT=5432
DB_SSL_MODE=disable

# Google Cloud (for local testing)
GOOGLE_CLOUD_PROJECT_ID=oceanic-beach-460916-n5
GOOGLE_APPLICATION_CREDENTIALS=./service-account-key.json

# AI Provider Selection
TEXT_PROVIDER=vertex  # vertex|openai
IMAGE_PROVIDER=vertex # vertex|openai|stability

# Vertex AI Configuration
VERTEX_AI_LOCATION=europe-west9
VERTEX_AI_MODEL_ID=gemini-2.0-flash
VERTEX_AI_OUTLINE_MODEL=gemini-2.0-flash

# Optional: OpenAI Configuration
OPENAI_API_KEY=your_openai_api_key

# Optional: Stability AI Configuration
STABILITY_API_KEY=your_stability_api_key

# Storage
STORAGE_BUCKET_NAME=mythoria-story-assets-europe-west9

# Workflows
WORKFLOWS_LOCATION=europe-west9
```

### Installation & Setup

```bash
# Clone and navigate to project
cd story-generation-workflow

# Install dependencies
npm install

# Validate environment
npm run env:validate

# Check database connection
npm run db:check

# Start development server
npm run dev
```

## Technology Stack

### Core Framework
- **Node.js 20+**: ES Modules with top-level await
- **TypeScript 5.7.2**: Strict type checking
- **Express.js 4.21.2**: Web framework with async handlers
- **Helmet**: Security middleware

### Database & ORM
- **Drizzle ORM 0.43.1**: Type-safe database operations
- **PostgreSQL**: Shared with mythoria-webapp
- **Connection Pooling**: Built-in with Drizzle

### Google Cloud Integration
- **@google-cloud/aiplatform**: Vertex AI SDK
- **@google-cloud/storage**: Cloud Storage SDK
- **@google-cloud/workflows**: Workflows SDK
- **@google-cloud/secret-manager**: Secret Manager SDK

### AI Providers
- **Vertex AI**: Primary text and image generation
- **OpenAI**: Alternative text generation and DALL-E
- **Stability AI**: Alternative image generation

### Development Tools
- **TSX**: Development server with hot reload
- **Jest**: Testing framework with ts-jest
- **ESLint**: TypeScript linting
- **Winston**: Structured logging
- **Zod**: Runtime type validation

## Project Structure

```
src/
├── config/                 # Configuration management
│   ├── database.ts        # Database connection setup
│   ├── environment.ts     # Environment validation with Zod
│   └── logger.ts          # Winston logging configuration
├── shared/                # Environment-agnostic business logic
│   ├── interfaces.ts     # Core service interfaces
│   ├── types.ts          # Shared data models and workflow types
│   ├── utils.ts          # Utility helpers
│   ├── ai-utils.ts       # Prompt utilities
│   ├── health.ts         # Health check helpers
│   └── index.ts          # Barrel exports
├── adapters/             # External service implementations
│   ├── database/         # Database adapters
│   │   └── drizzle.ts   # Drizzle ORM adapter
│   ├── storage/          # Cloud Storage adapters
│   │   └── gcs.ts       # Google Cloud Storage adapter
│   └── ai/              # AI service adapters
├── ai/                   # AI Gateway and providers
│   ├── gateway.ts        # Main AI Gateway facade
│   ├── context-manager.ts # Context preservation system
│   └── providers/        # Provider implementations
│       ├── vertex/       # Vertex AI implementation
│       ├── openai/       # OpenAI implementation
│       └── stability/    # Stability AI implementation
├── routes/               # Express route handlers
│   ├── health.ts         # Health check endpoints
│   ├── ai.ts            # AI Gateway endpoints
│   └── internal.ts      # Internal workflow endpoints
├── workflows/            # Workflow-related handlers
├── db/                   # Database schema (imported from mythoria-webapp)
├── types/                # TypeScript type definitions
└── index.ts             # Application entry point
```

## Development Workflows

### Running the Application

```bash
# Development mode with hot reload
npm run dev

# Production build
npm run build
npm run start

# Docker development
npm run docker:build
npm run docker:run

# Watch mode for testing
npm run test:watch
```

### Database Management

The service shares database schema with `mythoria-webapp`:

```bash
# Check database connection
npm run db:check

# View current schema (read-only)
npm run db:studio

# Migrations are managed by mythoria-webapp
# Run from mythoria-webapp directory:
# npm run db:migrate
```

### Testing Strategy

#### Unit Tests
```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# Coverage report
npm run test:coverage

# Specific test file
npm test -- basic.test.ts
```

#### Integration Tests
```bash
# Test with real AI providers (requires API keys)
npm run test:integration

# Test with mock providers
npm run test:mock
```

#### End-to-End Tests
```bash
# Test complete workflow
npm run test:e2e

# Test specific workflow step
npm run test:workflow -- outline
```

### Code Quality

#### Linting & Formatting
```bash
# Run ESLint
npm run lint

# Fix linting issues
npm run lint:fix

# Check TypeScript
npm run type-check
```

#### Pre-commit Hooks
```json
{
  "husky": {
    "hooks": {
      "pre-commit": "npm run lint && npm run type-check && npm test"
    }
  }
}
```

## Architecture Patterns

### Clean Architecture Implementation

#### 1. Dependency Injection
```typescript
// Service creation with dependency injection
const databaseAdapter = new DrizzleDatabaseAdapter(db);
const storageAdapter = new GCSStorageAdapter(bucket);
const aiGateway = AIGateway.fromEnvironment();

const workflowService = new WorkflowService(
  databaseAdapter,
  storageAdapter,
  aiGateway
);
```

#### 2. Interface-based Design
```typescript
// Abstract interfaces in shared/
export interface ITextGenerationService {
  complete(prompt: string, options?: CompletionOptions): Promise<string>;
  generateStructured<T>(prompt: string, schema: ZodSchema<T>): Promise<T>;
}

// Concrete implementations in adapters/
export class VertexTextService implements ITextGenerationService {
  async complete(prompt: string, options?: CompletionOptions): Promise<string> {
    // Vertex AI implementation
  }
}
```

#### 3. Provider Factory Pattern
```typescript
// AI Gateway factory
export class AIGateway {
  static fromEnvironment(): AIGateway {
    const textProvider = process.env.TEXT_PROVIDER;
    const imageProvider = process.env.IMAGE_PROVIDER;
    
    return new AIGateway(
      this.createTextService(textProvider),
      this.createImageService(imageProvider)
    );
  }
}
```

### Error Handling Patterns

#### 1. Structured Error Responses
```typescript
export class WorkflowError extends Error {
  constructor(
    message: string,
    public code: string,
    public step: string,
    public retryable: boolean = false
  ) {
    super(message);
    this.name = 'WorkflowError';
  }
}
```

#### 2. Async Error Boundary
```typescript
export const asyncHandler = (
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>
) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
```

### Context Management

#### AI Context Preservation
```typescript
// Context manager for maintaining conversation state
export class ContextManager {
  async initializeContext(
    contextId: string,
    storyId: string,
    systemPrompt: string
  ): Promise<void> {
    const context = {
      storyId,
      conversationHistory: [
        { role: 'system', content: systemPrompt, step: 'init' }
      ],
      providerData: {},
      createdAt: new Date(),
      lastUsedAt: new Date()
    };
    
    this.contexts.set(contextId, context);
  }
}
```

## Testing Guidelines

### Test Structure

#### Unit Tests (`src/tests/`)
```typescript
// Example unit test
describe('AIGateway', () => {
  describe('Text Generation', () => {
    it('should generate text using configured provider', async () => {
      const mockProvider = new MockTextService();
      const gateway = new AIGateway(mockProvider, mockImageService);
      
      const result = await gateway.generateText('test prompt');
      
      expect(result).toBeDefined();
      expect(mockProvider.complete).toHaveBeenCalledWith('test prompt');
    });
  });
});
```

#### Integration Tests
```typescript
// Example integration test
describe('Story Generation Integration', () => {
  it('should complete full workflow', async () => {
    const request = {
      storyId: 'test-story',
      runId: 'test-run',
      prompt: 'A magical adventure'
    };
    
    // Test actual AI providers (with rate limiting)
    const response = await request(app)
      .post('/ai/text/outline')
      .send(request)
      .expect(200);
      
    expect(response.body.outline).toBeDefined();
  });
});
```

### Mocking Strategy

#### AI Provider Mocks
```typescript
export class MockTextService implements ITextGenerationService {
  async complete(prompt: string): Promise<string> {
    return `Mock response for: ${prompt}`;
  }
  
  async generateStructured<T>(prompt: string, schema: ZodSchema<T>): Promise<T> {
    // Return valid mock data matching schema
    return {
      title: 'Mock Story',
      chapters: ['Chapter 1', 'Chapter 2']
    } as T;
  }
}
```

#### Database Mocks
```typescript
export class MockDatabaseAdapter implements IDatabaseAdapter {
  private stories = new Map();
  
  async updateStoryGenerationRun(runId: string, updates: object): Promise<void> {
    // Mock implementation
  }
}
```

## Debugging & Troubleshooting

### Logging Configuration

#### Structured Logging
```typescript
// Logger setup with Winston
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/app.log' })
  ]
});

// Usage in code
logger.info('Story generation started', {
  storyId,
  runId,
  provider: 'vertex'
});
```

#### Context-aware Logging
```typescript
// Add context to all log entries
export const createContextLogger = (context: { storyId: string; runId: string }) => {
  return logger.child(context);
};
```

### Debug Scripts

#### Quick Tests
```bash
# Test AI providers
npm run debug:ai

# Test database connection
npm run debug:db

# Test workflow steps
npm run debug:workflow
```

#### Environment Validation
```typescript
// Environment validation with detailed errors
export const validateEnvironment = () => {
  const schema = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    TEXT_PROVIDER: z.enum(['vertex', 'openai']),
    DB_HOST: z.string().min(1, 'DB_HOST is required'),
    // ... other validations
  });
  
  try {
    return schema.parse(process.env);
  } catch (error) {
    logger.error('Environment validation failed', { error });
    process.exit(1);
  }
};
```

### Performance Monitoring

#### Request Timing
```typescript
// Middleware for request timing
export const timingMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info('Request completed', {
      method: req.method,
      url: req.url,
      status: res.statusCode,
      duration
    });
  });
  
  next();
};
```

#### AI Provider Performance
```typescript
// Track AI provider response times
export class TimedTextService implements ITextGenerationService {
  constructor(private provider: ITextGenerationService) {}
  
  async complete(prompt: string, options?: CompletionOptions): Promise<string> {
    const start = Date.now();
    
    try {
      const result = await this.provider.complete(prompt, options);
      const duration = Date.now() - start;
      
      logger.info('AI request completed', {
        provider: this.provider.constructor.name,
        duration,
        promptLength: prompt.length,
        responseLength: result.length
      });
      
      return result;
    } catch (error) {
      const duration = Date.now() - start;
      logger.error('AI request failed', {
        provider: this.provider.constructor.name,
        duration,
        error: error.message
      });
      throw error;
    }
  }
}
```

## Coding Standards

### TypeScript Configuration
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Node",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true
  }
}
```

### Code Style Guidelines

#### 1. Naming Conventions
```typescript
// Classes: PascalCase
class StoryGenerationService {}

// Functions/variables: camelCase
const generateStoryOutline = async () => {};

// Constants: SCREAMING_SNAKE_CASE
const MAX_RETRY_ATTEMPTS = 3;

// Interfaces: PascalCase with 'I' prefix
interface ITextGenerationService {}

// Types: PascalCase
type WorkflowStep = 'outline' | 'chapters' | 'images';
```

#### 2. Function Design
```typescript
// Pure functions when possible
export const formatChapterTitle = (chapterNumber: number, title: string): string => {
  return `Chapter ${chapterNumber}: ${title}`;
};

// Async functions with proper error handling
export const generateChapterContent = async (
  chapter: ChapterRequest
): Promise<ChapterResponse> => {
  try {
    // Implementation
  } catch (error) {
    logger.error('Chapter generation failed', { chapter: chapter.number, error });
    throw new WorkflowError(
      'Failed to generate chapter content',
      'CHAPTER_GENERATION_FAILED',
      'write_chapters',
      true // retryable
    );
  }
};
```

#### 3. Type Safety
```typescript
// Use discriminated unions for workflow states
type WorkflowState = 
  | { status: 'queued' }
  | { status: 'running'; currentStep: string }
  | { status: 'completed'; result: StoryResult }
  | { status: 'failed'; error: string };

// Strict input validation
const validateStoryRequest = (input: unknown): StoryRequest => {
  return storyRequestSchema.parse(input);
};
```

## Security Guidelines

### Input Validation
```typescript
// Always validate external input
export const createStorySchema = z.object({
  title: z.string().min(1).max(200),
  prompt: z.string().min(10).max(2000),
  genre: z.enum(['fantasy', 'scifi', 'mystery', 'romance']).optional(),
  targetAudience: z.enum(['children', 'young_adult', 'adult']).optional()
});
```

### Secret Management
```typescript
// Never log sensitive data
logger.info('AI request started', {
  provider: 'vertex',
  model: model,
  // API key excluded from logs
});

// Use environment variables for secrets
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  throw new Error('OPENAI_API_KEY environment variable is required');
}
```

### Error Information
```typescript
// Don't expose internal errors to clients
export const errorHandler = (
  error: Error,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  logger.error('Request failed', { error, url: req.url });
  
  // Generic error response for clients
  res.status(500).json({
    error: 'Internal server error',
    requestId: req.id
  });
};
```

## Contributing Guidelines

### Pull Request Process
1. **Branch naming**: `feature/description` or `fix/description`
2. **Commit messages**: Conventional commits format
3. **Tests required**: All new features must include tests
4. **Documentation**: Update relevant documentation
5. **Code review**: At least one reviewer required

### Development Checklist
- [ ] Code follows style guidelines
- [ ] All tests pass
- [ ] Type checking passes
- [ ] Linting passes
- [ ] Documentation updated
- [ ] Environment variables documented
- [ ] Error handling implemented
- [ ] Logging added for debugging
