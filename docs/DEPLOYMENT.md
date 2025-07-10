# Story Generation Workflow - Deployment Guide

## Overview

This guide covers deploying the Story Generation Workflow service to Google Cloud Platform using Cloud Run, with supporting services including Cloud Workflows, Pub/Sub, and Cloud SQL.

## Prerequisites

- Google Cloud CLI installed and authenticated
- Docker installed for container builds
- Access to Google Cloud Project: `oceanic-beach-460916-n5`
- Required IAM permissions for deployment

## Google Cloud Platform Setup

### Project Information
- **Project ID**: `oceanic-beach-460916-n5`
- **Region**: `europe-west9` (Paris)
- **Service Account**: `wf-story-gen-sa@oceanic-beach-460916-n5.iam.gserviceaccount.com`

### Required Google Cloud APIs
```bash
# Enable required APIs
gcloud services enable cloudbuild.googleapis.com
gcloud services enable run.googleapis.com
gcloud services enable workflows.googleapis.com
gcloud services enable aiplatform.googleapis.com
gcloud services enable storage.googleapis.com
gcloud services enable secretmanager.googleapis.com
gcloud services enable pubsub.googleapis.com
```

## Cloud Run Service

### Service Configuration
- **Service Name**: `story-generation-workflow`
- **Full URL**: `https://story-generation-workflow-803421888801.europe-west9.run.app`
- **Container Registry**: `europe-west9-docker.pkg.dev/oceanic-beach-460916-n5/mythoria/story-generation-workflow`

### Environment Variables (Production)
```yaml
# Database Connection
DB_HOST: ${SECRET:mythoria-db-host}
DB_USER: ${SECRET:mythoria-db-user}
DB_PASSWORD: ${SECRET:mythoria-db-password}
DB_NAME: mythoria
DB_PORT: 5432

# Google Cloud Project
GOOGLE_CLOUD_PROJECT_ID: oceanic-beach-460916-n5

# AI Configuration
TEXT_PROVIDER: vertex
IMAGE_PROVIDER: vertex
VERTEX_AI_LOCATION: europe-west9
VERTEX_AI_MODEL_ID: ${SECRET:mythoria-vertex-ai-model}

# TTS Configuration
TTS_PROVIDER: openai
TTS_MODEL: tts-1
TTS_VOICE: nova
TTS_SPEED: 0.9
TTS_LANGUAGE: en-US
OPENAI_API_KEY: ${SECRET:mythoria-openai-api-key}

# Storage
STORAGE_BUCKET_NAME: ${SECRET:mythoria-storage-bucket}

# Workflows
GOOGLE_CLOUD_REGION: europe-west9

# Application
NODE_ENV: production
PORT: 8080
```

### Service Account Permissions
```bash
# Cloud Run service account roles
gcloud projects add-iam-policy-binding oceanic-beach-460916-n5 \
    --member="serviceAccount:wf-story-gen-sa@oceanic-beach-460916-n5.iam.gserviceaccount.com" \
    --role="roles/aiplatform.user"

gcloud projects add-iam-policy-binding oceanic-beach-460916-n5 \
    --member="serviceAccount:wf-story-gen-sa@oceanic-beach-460916-n5.iam.gserviceaccount.com" \
    --role="roles/storage.objectAdmin"

gcloud projects add-iam-policy-binding oceanic-beach-460916-n5 \
    --member="serviceAccount:wf-story-gen-sa@oceanic-beach-460916-n5.iam.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"

gcloud projects add-iam-policy-binding oceanic-beach-460916-n5 \
    --member="serviceAccount:wf-story-gen-sa@oceanic-beach-460916-n5.iam.gserviceaccount.com" \
    --role="roles/workflows.invoker"

gcloud projects add-iam-policy-binding oceanic-beach-460916-n5 \
    --member="serviceAccount:wf-story-gen-sa@oceanic-beach-460916-n5.iam.gserviceaccount.com" \
    --role="roles/run.invoker"
```

## Google Cloud Workflows

### Workflow Configuration
- **Workflow Name**: `story-generation`
- **Location**: `europe-west9`
- **Trigger**: Pub/Sub topic `mythoria-story-requests`
- **Definition File**: `workflows/story-generation.yaml`

### Workflow Deployment
```bash
# Deploy workflow using gcloud
gcloud workflows deploy story-generation \
    --source=workflows/story-generation.yaml \
    --location=europe-west9 \
    --service-account=wf-story-gen-sa@oceanic-beach-460916-n5.iam.gserviceaccount.com
```

### Pub/Sub Configuration
```bash
# Create topic for story requests
gcloud pubsub topics create mythoria-story-requests

# Create subscription for workflows
gcloud pubsub subscriptions create story-generation-workflow-sub \
    --topic=mythoria-story-requests

# Set up Eventarc trigger
gcloud eventarc triggers create story-generation-trigger \
    --location=europe-west9 \
    --destination-workflow=story-generation \
    --destination-workflow-location=europe-west9 \
    --event-filters="type=google.cloud.pubsub.topic.v1.messagePublished" \
    --event-filters="topic=projects/oceanic-beach-460916-n5/topics/mythoria-story-requests" \
    --service-account=wf-story-gen-sa@oceanic-beach-460916-n5.iam.gserviceaccount.com
```

## Google Cloud Storage

### Storage Buckets
- **Primary Bucket**: `mythoria-story-assets-europe-west9`
- **Backup Bucket**: `mythoria-story-assets-backup-europe-west9`

### Bucket Configuration
```bash
# Create primary storage bucket
gsutil mb -p oceanic-beach-460916-n5 -c STANDARD -l europe-west9 gs://mythoria-story-assets-europe-west9

# Create backup bucket
gsutil mb -p oceanic-beach-460916-n5 -c COLDLINE -l europe-west9 gs://mythoria-story-assets-backup-europe-west9

# Set bucket permissions
gsutil iam ch serviceAccount:wf-story-gen-sa@oceanic-beach-460916-n5.iam.gserviceaccount.com:objectAdmin gs://mythoria-story-assets-europe-west9
```

### Storage Structure
```
gs://mythoria-story-assets-europe-west9/
├── {storyId}/
│   ├── chapters/
│   │   ├── chapter_1.png
│   │   ├── chapter_2.png
│   │   └── ...
│   ├── audio/
│   │   ├── chapter_1.mp3
│   │   ├── chapter_2.mp3
│   │   └── ...
│   ├── final/
│   │   ├── story_v001.html
│   │   ├── story.pdf
│   │   └── story.mp3 (optional)
│   └── metadata.json
└── temp/
    └── {runId}/
        └── temporary-files/
```

## Secret Manager Configuration

### Shared Secrets (from mythoria-webapp)
```bash
# Database credentials
gcloud secrets create mythoria-db-host --data-file=<(echo "your-db-host")
gcloud secrets create mythoria-db-user --data-file=<(echo "your-db-user")
gcloud secrets create mythoria-db-password --data-file=<(echo "your-db-password")
```

### Story Generation Specific Secrets
```bash
# Storage configuration
gcloud secrets create mythoria-storage-bucket --data-file=<(echo "mythoria-story-assets-europe-west9")

# AI model configuration
gcloud secrets create mythoria-vertex-ai-model --data-file=<(echo "gemini-2.5-flash")

# Optional: OpenAI API key for multi-provider support and TTS
gcloud secrets create mythoria-openai-api-key --data-file=<(echo "your-openai-api-key")

# Optional: Stability AI API key
gcloud secrets create mythoria-stability-api-key --data-file=<(echo "your-stability-api-key")
```

### Secret Access Permissions
```bash
# Grant access to secrets
gcloud secrets add-iam-policy-binding mythoria-storage-bucket \
    --member="serviceAccount:wf-story-gen-sa@oceanic-beach-460916-n5.iam.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"

gcloud secrets add-iam-policy-binding mythoria-vertex-ai-model \
    --member="serviceAccount:wf-story-gen-sa@oceanic-beach-460916-n5.iam.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
```

## Database Configuration

### Shared Database Schema
The service shares the PostgreSQL database with `mythoria-webapp` using Drizzle ORM migrations.

**Connection Details:**
- **Host**: Managed through `mythoria-db-host` secret
- **Database**: `mythoria`
- **Port**: `5432`
- **SSL**: Required in production

### Migration Management
```bash
# Migrations are managed by mythoria-webapp
# SGW imports the schema from the parent application

# Check migration status
npm run db:check

# Apply pending migrations (run from mythoria-webapp)
npm run db:migrate
```

### Required Tables
- `stories` - Main story records
- `story_generation_runs` - Workflow execution tracking
- `chapters` - Chapter content and metadata
- `drizzle_migrations` - Migration history (shared)

## Vertex AI Configuration

### Model Configuration
- **Primary Model**: `gemini-2.5-flash`
- **Location**: `europe-west9`
- **Backup Model**: `gemini-2.0-flash`

### Model Endpoints
```bash
# Text Generation
projects/oceanic-beach-460916-n5/locations/europe-west9/publishers/google/models/gemini-2.5-flash

# Image Generation
projects/oceanic-beach-460916-n5/locations/europe-west9/publishers/google/models/imagegeneration@001
```

### Quota Requirements
- **Text Generation**: 1000 requests/minute, 10M tokens/minute
- **Image Generation**: 100 requests/minute, 500 images/minute

## CI/CD Pipeline (Cloud Build)

### Build Configuration (`cloudbuild.yaml`)
```yaml
steps:  # Build container image
  - name: 'gcr.io/cloud-builders/docker'
    args: [
      'build', 
      '-t', 'europe-west9-docker.pkg.dev/oceanic-beach-460916-n5/mythoria/story-generation-workflow:${COMMIT_SHA}',
      '-t', 'europe-west9-docker.pkg.dev/oceanic-beach-460916-n5/mythoria/story-generation-workflow:latest',
      '.'
    ]
  
  # Push to Artifact Registry
  - name: 'gcr.io/cloud-builders/docker'
    args: ['push', '--all-tags', 'europe-west9-docker.pkg.dev/oceanic-beach-460916-n5/mythoria/story-generation-workflow']
  
  # Deploy to Cloud Run
  - name: 'gcr.io/google.com/cloudsdktool/cloud-sdk'
    entrypoint: 'gcloud'
    args: [
      'run', 'deploy', 'story-generation-workflow',
      '--image', 'europe-west9-docker.pkg.dev/oceanic-beach-460916-n5/mythoria/story-generation-workflow:${COMMIT_SHA}',
      '--region', 'europe-west9',
      '--platform', 'managed',
      '--service-account', 'wf-story-gen-sa@oceanic-beach-460916-n5.iam.gserviceaccount.com',
      '--set-env-vars', 'GOOGLE_CLOUD_PROJECT_ID=oceanic-beach-460916-n5,NODE_ENV=production',
      '--set-secrets', '/etc/secrets/db-host=mythoria-db-host:latest,/etc/secrets/db-password=mythoria-db-password:latest'
    ]
  
  # Deploy workflow
  - name: 'gcr.io/google.com/cloudsdktool/cloud-sdk'
    entrypoint: 'gcloud'
    args: [
      'workflows', 'deploy', 'story-generation',
      '--source', 'workflows/story-generation.yaml',
      '--location', 'europe-west9'
    ]

options:
  logging: CLOUD_LOGGING_ONLY
  machineType: 'E2_HIGHCPU_8'
```

### Artifact Registry
```bash
# Create repository
gcloud artifacts repositories create mythoria \
    --repository-format=docker \
    --location=europe-west9 \
    --description="Mythoria container images"
```

## Deployment Commands

### Automated Deployment (Recommended)
```bash
# Deploy using Cloud Build
gcloud builds submit --config cloudbuild.yaml

# Or using npm script
npm run gcp:deploy
```

### Manual Deployment
```bash
# 1. Build and push container
docker build -t europe-west9-docker.pkg.dev/oceanic-beach-460916-n5/mythoria/story-generation-workflow:latest .
docker push europe-west9-docker.pkg.dev/oceanic-beach-460916-n5/mythoria/story-generation-workflow:latest

# 2. Deploy to Cloud Run
gcloud run deploy story-generation-workflow \
    --image europe-west9-docker.pkg.dev/oceanic-beach-460916-n5/mythoria/story-generation-workflow:latest \
    --region europe-west9 \
    --platform managed \
    --service-account wf-story-gen-sa@oceanic-beach-460916-n5.iam.gserviceaccount.com

# 3. Deploy workflow
gcloud workflows deploy story-generation \
    --source workflows/story-generation.yaml \
    --location europe-west9
```

### Local Development Setup
```bash
# 1. Install dependencies
npm install

# 2. Setup environment
cp .env.example .env
# Edit .env with local values

# 3. Setup database (use shared database from mythoria-webapp)
npm run db:check

# 4. Start development server
npm run dev

# 5. Test endpoints
curl http://localhost:3000/health
```

## Monitoring and Observability

### Cloud Logging
- **Log Name**: `story-generation-workflow`
- **Structured JSON logging** with Winston
- **Log Levels**: ERROR, WARN, INFO, DEBUG

### Cloud Monitoring
```bash
# Create alerting policy for errors
gcloud alpha monitoring policies create \
    --policy-from-file=monitoring/error-alert-policy.yaml
```

### Health Checks
- **Endpoint**: `GET /health`
- **Checks**: Database connectivity, Internet access, AI provider status
- **Response Format**: Structured JSON with component status

### Error Tracking
- Google Cloud Error Reporting integration
- Structured error logging with stack traces
- Workflow execution monitoring

## Security Configuration

### Service Account Security
```bash
# Principle of least privilege - only required permissions
gcloud projects add-iam-policy-binding oceanic-beach-460916-n5 \
    --member="serviceAccount:wf-story-gen-sa@oceanic-beach-460916-n5.iam.gserviceaccount.com" \
    --role="roles/aiplatform.user"
    
# No broad admin roles
```

### Network Security
- **HTTPS only** for all external communications
- **VPC Connector** for private database access (optional)
- **Firewall rules** for restricted access

### Data Security
- **Encryption at rest** for Cloud Storage
- **Encryption in transit** for all API calls
- **Secret Manager** for sensitive configuration
- **Input validation** with Zod schemas

## Disaster Recovery

### Backup Strategy
- **Database backups** managed by mythoria-webapp
- **Storage bucket backups** to coldline storage
- **Container image backups** in Artifact Registry

### Recovery Procedures
```bash
# 1. Restore from backup bucket
gsutil -m cp -r gs://mythoria-story-assets-backup-europe-west9/* gs://mythoria-story-assets-europe-west9/

# 2. Redeploy service
gcloud run deploy story-generation-workflow \
    --image europe-west9-docker.pkg.dev/oceanic-beach-460916-n5/mythoria/story-generation-workflow:latest \
    --region europe-west9

# 3. Redeploy workflow
gcloud workflows deploy story-generation \
    --source workflows/story-generation.yaml \
    --location europe-west9
```

## Cost Optimization

### Resource Optimization
- **Cloud Run**: Auto-scaling with minimum 0 instances
- **Vertex AI**: Efficient model selection (Flash vs Pro)
- **Storage**: Lifecycle policies for old content
- **Workflows**: Pay-per-execution model

### Cost Monitoring
```bash
# Set up budget alerts
gcloud billing budgets create \
    --billing-account=YOUR_BILLING_ACCOUNT_ID \
    --display-name="Story Generation Workflow Budget" \
    --budget-amount=100USD
```

## Troubleshooting

### Common Issues

#### 1. Service Account Permissions
```bash
# Check service account roles
gcloud projects get-iam-policy oceanic-beach-460916-n5 \
    --flatten="bindings[].members" \
    --format="table(bindings.role)" \
    --filter="bindings.members:wf-story-gen-sa@oceanic-beach-460916-n5.iam.gserviceaccount.com"
```

#### 2. Secret Access Issues
```bash
# Test secret access
gcloud secrets versions access latest --secret="mythoria-db-host"
```

#### 3. Workflow Execution Failures
```bash
# List workflow executions
gcloud workflows executions list \
    --workflow=story-generation \
    --location=europe-west9

# Get execution details
gcloud workflows executions describe EXECUTION_ID \
    --workflow=story-generation \
    --location=europe-west9
```

#### 4. Cloud Run Service Issues
```bash
# Check service logs
gcloud logs read "resource.type=cloud_run_revision AND resource.labels.service_name=story-generation-workflow" \
    --limit=50

# Check service status
gcloud run services describe story-generation-workflow \
    --region=europe-west9
```

### Debug Commands
```bash
# Test workflow execution
gcloud workflows execute story-generation \
    --location=europe-west9 \
    --data='{"storyId":"test-123","runId":"run-456"}'

# Test Cloud Run endpoints
curl -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
    https://story-generation-workflow-803421888801.europe-west9.run.app/health

# Check database connectivity
npm run db:check
```
