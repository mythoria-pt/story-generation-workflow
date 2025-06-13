# AGENTS.md - Story Generation Workflow Service

## Project Overview

**Service Name**: `story-generation-workflow`  
**Version**: 0.1.0  
**Type**: Google Cloud Run Microservice  
**Purpose**: Orchestrates complete story generation process using Google Cloud Workflows, Vertex AI, and Cloud Storage

## Architecture

### Core Concept
This is a microservice that implements a multi-step workflow for generating complete illustrated stories. It follows a clean architecture pattern with environment-agnostic business logic and swappable adapters for external services.

### Workflow Steps
1. **Story Outline** - Generate story structure, synopsis, and chapter outlines
2. **Chapter Writing** - Write detailed content for each chapter with image prompts  
3. **Image Generation** - Generate illustrations using Vertex AI Image Generation
4. **Final Production** - Combine content and images into HTML and PDF formats
5. **Audio Recording** - Optional narration generation using text-to-speech

## Technology Stack

### Runtime & Framework
- **Node.js**: 20+ (ES Modules)
- **TypeScript**: 5.7.2 with strict configuration
- **Express.js**: 4.21.2 for HTTP server
- **Helmet**: Security middleware

### Google Cloud Services
- **Cloud Run**: Container hosting platform
- **Cloud Workflows**: Orchestration engine
- **Vertex AI**: Text and image generation
- **Cloud Storage**: Asset storage
- **PostgreSQL**: Shared database with mythoria-webapp

### Database & ORM
- **Drizzle ORM**: 0.43.1 for type-safe database operations
- **PostgreSQL**: Shared with mythoria-webapp
- **Migrations**: Shared migration table `drizzle_migrations`

### Development Tools
- **Jest**: Testing framework with ts-jest
- **ESLint**: TypeScript linting
- **Winston**: Structured logging
- **Zod**: Runtime type validation
- **TSX**: Development server with hot reload

## Project Structure

```
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
- **Region**: us-central1 (default)
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
