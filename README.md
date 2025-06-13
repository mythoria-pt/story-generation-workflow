# Story Generation Workflow Service

A Google Cloud Run microservice that orchestrates the complete story generation process using Google Cloud Workflows, Vertex AI, and Cloud Storage.

## Architecture Overview

This service implements a multi-step workflow for generating complete illustrated stories:

1. **Story Outline** - Generate story structure, synopsis, and chapter outlines
2. **Chapter Writing** - Write detailed content for each chapter with image prompts
3. **Image Generation** - Generate illustrations using Vertex AI Image Generation
4. **Final Production** - Combine content and images into HTML and PDF formats
5. **Audio Recording** - Optional narration generation using text-to-speech

## Project Structure

```
src/
├── config/           # Environment and configuration management
├── shared/           # Environment-agnostic business logic and interfaces
├── adapters/         # External service implementations (swappable with mocks)
├── workflows/        # Google Cloud Workflows definitions and handlers
└── db/              # Database schema (shared with mythoria-webapp)
```

## Architecture Principles

- **Single Dockerfile** per microservice with distroless base for security
- **Environment-agnostic logic** in `shared/` for easy unit testing
- **Interface-based adapters** for external services (database, Google Cloud)
- **Reproducible builds** using npm ci and locked dependencies

## Prerequisites

- Node.js 20+
- Google Cloud Project with enabled APIs:
  - Cloud Run
  - Cloud Workflows  
  - Vertex AI
  - Cloud Storage
- PostgreSQL database (shared with mythoria-webapp)

## Environment Setup

1. Copy environment template:
   ```bash
   cp .env.example .env
   ```

2. Fill in required values in `.env`:
   ```env
   GOOGLE_CLOUD_PROJECT_ID=your-project-id
   STORAGE_BUCKET_NAME=your-bucket-name
   DB_HOST=your-db-host
   DB_PASSWORD=your-db-password
   # ... other required vars
   ```

3. Validate environment:
   ```bash
   npm run env:validate
   ```

## Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Run tests
npm test

# Build for production
npm run build
```

## Database

This service shares the same Drizzle database schema and migrations with `mythoria-webapp`. The schema is imported from the parent application to maintain consistency.

## Deployment

### Prerequisites for Production

1. **Set up Google Cloud Secrets** (first time only):
   ```bash
   # Set up secrets for the story generation workflow
   npm run gcp:setup-secrets
   ```

2. **Verify setup**:
   ```bash
   npm run gcp:verify
   ```

### Production Deployment

Deploy to Google Cloud using the automated build pipeline:

```bash
# Deploy using the updated cloudbuild.yaml with Google Secrets
npm run gcp:deploy

# Or manually using gcloud
gcloud builds submit --config cloudbuild.yaml
```

The deployment will:
- Build the Docker container
- Deploy to Cloud Run in `europe-west9` region
- Configure environment variables from Google Secrets
- Deploy the associated workflow definition

### Local Development

For local development, use the standard environment files:

```bash
# Local Docker Build
npm run docker:build
npm run docker:run

# Development mode
npm run dev
```

### Environment Configuration

This service is configured to work with Google Cloud Secrets in production while supporting local development:

- **Production**: Uses Google Cloud Secret Manager for sensitive values
- **Development**: Uses `.env` and `.env.local` files
- **Shared Database**: Reuses the same PostgreSQL database as mythoria-webapp

### Secrets Management

The service reuses secrets from the mythoria-webapp project for shared resources:
- Database credentials: `mythoria-db-host`, `mythoria-db-user`, `mythoria-db-password`

And creates additional secrets for story-specific configuration:
- Storage: `mythoria-storage-bucket`
- AI Models: `mythoria-vertex-ai-model`, `mythoria-vertex-ai-location`
- Workflows: `mythoria-workflows-location`

## API Endpoints

- `GET /health` - Health check endpoint
- `POST /api/workflow/story-outline` - Generate story outline
- `POST /api/workflow/chapter-writing` - Write chapter content
- `POST /api/workflow/image-generation` - Generate images
- `POST /api/workflow/final-production` - Create final output
- `POST /api/workflow/audio-recording` - Generate narration (optional)

## Testing

The service includes comprehensive test setup with mocked Google Cloud services:

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# Coverage report
npm run test:coverage
```

## Monitoring and Logging

- Structured JSON logging with Winston
- Health check endpoint for monitoring
- Error tracking and reporting
- Performance metrics collection

## Security

- Helmet.js for security headers
- Input validation with Zod
- Distroless container images
- Principle of least privilege for Google Cloud IAM

## Google Cloud Workflows

This service includes Google Cloud Workflows for orchestrating the story generation process.

### Workflow Deployment

The `story-generation` workflow is automatically deployed via Cloud Build, but you can also deploy it manually:

```bash
# Deploy the workflow
gcloud workflows deploy story-generation \
  --source=src/workflows/story-generation.yaml \
  --location=europe-west9
```

### Workflow Execution

Execute the workflow using the provided scripts:

```powershell
# Execute workflow with custom parameters
.\scripts\execute-workflow.ps1 -StoryId "my-story-123" -Prompt "A magical adventure"

# Run a test execution
.\scripts\test-workflow.ps1
```

Or execute directly with gcloud:

```bash
# Create request data file
echo '{
  "storyId": "story-123",
  "workflowId": "workflow-456", 
  "baseUrl": "https://your-cloud-run-url",
  "prompt": "Your story prompt"
}' > request.json

# Execute workflow
gcloud workflows execute story-generation \
  --location=europe-west9 \
  --data-file=request.json
```

### Workflow Monitoring

Monitor workflow executions:

```bash
# List recent executions
gcloud workflows executions list --location=europe-west9 --workflow=story-generation

# Get execution details
gcloud workflows executions describe EXECUTION_ID \
  --location=europe-west9 \
  --workflow=story-generation
```

## Related Services

- **mythoria-webapp** - Main web application sharing the database schema
- **Google Cloud Workflows** - Orchestration engine for the story generation process
