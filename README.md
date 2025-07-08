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
- **[TTS Implementation](./docs/TTS_IMPLEMENTATION.md)** - Text-to-Speech audiobook generation with OpenAI and Vertex AI
- **[Progress Tracking](./docs/PROGRESS_TRACKING_IMPLEMENTATION.md)** - Real-time story generation progress updates and completion percentage calculation

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
  -d '{"storyId": "story-123", "runId": "run-456"}'
```

### Edit an Existing Story
```bash
curl -X POST http://localhost:3000/story-edit \
  -H "Content-Type: application/json" \
  -d '{
    "storyId": "550e8400-e29b-41d4-a716-446655440000",
    "chapterNumber": 2,
    "userRequest": "Make the dragon more friendly and less scary for young children"
  }'
```

### Check Service Health
```bash
curl http://localhost:3000/health
```

## Troubleshooting

### Port Conflicts

If you encounter `EADDRINUSE: address already in use :::8080`, the service will automatically find an available port in development mode. You can also:

1. **Set a custom port**: Create a `.env` file and set `PORT=8081` (or any available port)
2. **Stop other services**: Check what's using port 8080 with `netstat -ano | findstr :8080` on Windows
3. **Kill the process**: Use `taskkill /PID <process_id> /F` to stop the conflicting process

The service will automatically try ports 8081, 8082, etc. if 8080 is unavailable when no explicit PORT is set.

### Common Issues

- **Database connection errors**: Ensure PostgreSQL is running and credentials are correct
- **Google Cloud authentication**: Run `gcloud auth application-default login`
- **Missing environment variables**: Copy `.env.example` to `.env` and configure

## AI Debugging

The service includes comprehensive debugging capabilities to help diagnose AI-related issues.

### Debug Levels

The service logs AI interactions at different levels:

1. **INFO Level** (Default): Basic request/response metadata
2. **DEBUG Level**: Full prompts and responses (enabled via environment variables)

### Enable Full AI Debugging

To see complete prompts and responses from AI providers:

```powershell
# Enable full debugging
.\scripts\enable-ai-debug.ps1

# Or manually set environment variables
$env:DEBUG_AI_FULL_PROMPTS = "true"
$env:DEBUG_AI_FULL_RESPONSES = "true"
```

### Disable Full AI Debugging

```powershell
# Disable full debugging
.\scripts\disable-ai-debug.ps1

# Or manually remove environment variables
Remove-Item Env:DEBUG_AI_FULL_PROMPTS -ErrorAction SilentlyContinue
Remove-Item Env:DEBUG_AI_FULL_RESPONSES -ErrorAction SilentlyContinue
```

### Debug Information Logged

The service logs the following information to help diagnose AI issues:

#### Request Level (INFO)
- AI provider being used (Vertex AI, OpenAI)
- Model name and parameters (temperature, max tokens, etc.)
- Prompt length and preview (first 500 characters)
- Whether JSON schema is being used

#### Response Level (INFO)
- Response length and preview (first 500 characters)
- Response format detection (JSON, markdown code blocks, etc.)
- Character analysis (first/last characters, backticks detection)

#### Full Debug Level (DEBUG - when enabled)
- Complete prompts sent to AI providers
- Complete responses received from AI providers
- JSON schemas and request parameters
- Context history and conversation state

### Troubleshooting AI Issues

Common AI-related issues and their solutions:

#### JSON Parsing Errors
The error `Failed to parse outline JSON` typically occurs when the AI returns text wrapped in markdown code blocks instead of raw JSON.

**Debugging steps:**
1. Enable full AI debugging to see the exact response
2. Check the logs for `AI Response Debug` entries
3. Look for `containsJsonMarkers: true` indicating markdown formatting
4. The service automatically attempts to clean markdown code blocks

**Example error pattern:**
```
"outline": "```json\n{\"bookTitle\": \"...\"}..."
```

The service will automatically extract JSON from `\`\`\`json` blocks, but you can see this process in the debug logs.

#### Model Configuration Issues
- **Wrong model**: Check the `VERTEX_AI_OUTLINE_MODEL` environment variable
- **JSON schema support**: Ensure the model supports structured output
- **Rate limits**: Monitor the debug logs for rate limiting responses

#### Provider Authentication Issues  
- **Vertex AI**: Ensure `GOOGLE_CLOUD_PROJECT_ID` is set and authentication is configured
- **OpenAI**: Verify `OPENAI_API_KEY` is valid and has sufficient credits

### Log Analysis

Search for these log entries to diagnose issues:

```bash
# AI request debugging
grep "AI Request Debug" logs/app.log

# AI response debugging  
grep "AI Response Debug" logs/app.log

# JSON parsing issues
grep "Failed to parse outline JSON" logs/app.log

# Provider-specific logs
grep "Vertex AI Debug" logs/app.log
grep "OpenAI.*Debug" logs/app.log
```

## Environment Configuration

### Environment Variables vs Secrets

This service uses a hybrid approach for configuration:

**Environment Variables** (non-sensitive configuration):
- `STORAGE_BUCKET_NAME` - Google Cloud Storage bucket name
- `VERTEX_AI_MODEL_ID` - Vertex AI model identifier  
- `VERTEX_AI_LOCATION` - Vertex AI service location
- `GOOGLE_CLOUD_REGION` - Google Cloud Workflows location
- `IMAGE_GENERATION_MODEL` - Image generation model name
- `AUDIO_GENERATION_MODEL` - Audio generation model name
- `IMAGE_PROVIDER` - AI image provider selection
- `OPENAI_IMAGE_MODEL` - OpenAI image model name

**Google Cloud Secrets** (sensitive data only):
- `mythoria-db-host` - Database host
- `mythoria-db-user` - Database username
- `mythoria-db-password` - Database password
- `mythoria-openai-api-key` - OpenAI API key

### Secret Management Migration

If you have existing secrets from a previous version, you can clean them up:

```powershell
# Remove old secrets that are now environment variables
.\scripts\cleanup-old-secrets.ps1 -ProjectId your-project-id
```

### Key environment variables for local development:

```env
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
