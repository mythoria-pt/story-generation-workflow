# Story Generation Workflow Service

## About Mythoria

**Mythoria** is an AI-powered storytelling platform that creates personalized, illustrated stories for children and young adults. The platform combines advanced AI text generation with image creation to produce complete, engaging narratives with beautiful illustrations.

### The Mythoria Ecosystem

- **mythoria-webapp**: Main web application where users create and manage stories
- **story-generation-workflow**: This microservice that orchestrates the AI-powered story creation process
- **Shared Database**: PostgreSQL database shared between services for consistent data management

## Service Overview

The **Story Generation Workflow Service** is a Google Cloud Run microservice that orchestrates the complete story generation process using Google Cloud Workflows and multiple AI providers (Vertex AI, OpenAI, Stability AI).

### Key Features

- 🎨 **Multi-step Story Creation**: Automated outline → chapters → illustrations → final production
- 🔄 **Provider-Agnostic AI**: Supports multiple AI providers with easy switching
- 📊 **Observable Workflows**: Complete monitoring and logging throughout the process
- 🏗️ **Clean Architecture**: Environment-agnostic business logic with swappable adapters
- ⚡ **Parallel Processing**: Concurrent chapter writing and image generation
- 🔒 **Production-Ready**: Security, error handling, and monitoring built-in

## Quick Start

```bash
# Install dependencies
npm install

# Setup environment
cp .env.example .env
# Edit .env with your configuration

# Start development server
npm run dev

# Run tests
npm test
```

## Documentation

### 📚 Detailed Documentation

- **[Architecture Guide](./docs/ARCHITECTURE.md)** - System design, workflows, and component architecture with Mermaid diagrams
- **[Deployment Guide](./docs/DEPLOYMENT.md)** - Google Cloud services setup, configuration, and deployment procedures  
- **[Development Guide](./docs/DEVELOPMENT.md)** - Development environment, coding standards, testing, and contribution guidelines

### 🤖 AI Agent Documentation

- **[AGENTS.md](./AGENTS.md)** - Comprehensive context for AI coding agents including project structure, conventions, and best practices

## Project Structure

```
src/
├── config/           # Environment and configuration management
├── shared/           # Environment-agnostic business logic and interfaces
├── adapters/         # External service implementations (swappable with mocks)
├── ai/              # AI Gateway and provider implementations
├── routes/          # Express route handlers (health, AI, internal APIs)
├── workflows/       # Google Cloud Workflows handlers
└── db/              # Database schema (shared with mythoria-webapp)
```

## Technology Stack

- **Runtime**: Node.js 20+ with TypeScript and ES Modules
- **Framework**: Express.js with Helmet security middleware
- **Database**: PostgreSQL with Drizzle ORM (shared schema)
- **AI Providers**: Vertex AI, OpenAI, Stability AI
- **Cloud Platform**: Google Cloud (Run, Workflows, Storage, Secret Manager)
- **Testing**: Jest with comprehensive unit and integration tests

## Quick Examples

### Generate a Story Outline
```bash
curl -X POST http://localhost:3000/ai/text/outline \
  -H "Content-Type: application/json" \
  -d '{"storyId": "story-123", "prompt": "A magical dragon adventure"}'
```

### Check Service Health
```bash
curl http://localhost:3000/health
```

## Environment Configuration

Key environment variables for local development:```env
# AI Provider Selection
TEXT_PROVIDER=vertex         # vertex|openai  
IMAGE_PROVIDER=vertex        # vertex|openai|stability

# Database (shared with mythoria-webapp)
DB_HOST=localhost
DB_PASSWORD=your_password

# Google Cloud Configuration  
GOOGLE_CLOUD_PROJECT_ID=your-project-id
VERTEX_AI_LOCATION=europe-west9
STORAGE_BUCKET_NAME=your-bucket-name
```

## License

This project is part of the Mythoria platform. All rights reserved.

## Related Services

- **[mythoria-webapp](../mythoria-webapp/)** - Main web application
- **Shared Database Schema** - PostgreSQL database shared between services
