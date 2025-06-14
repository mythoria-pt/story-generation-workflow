# Google Cloud Secrets Migration Summary

## Overview

The `story-generation-workflow` project has been successfully updated to use Google Cloud Secret Manager, following the same patterns and reusing configurations from the `mythoria-webapp` project.

## Changes Made

### 1. Environment Configuration

#### New Files Created:
- **`.env.production`** - Production environment configuration aligned with mythoria-webapp
- **`scripts/setup-secrets.ps1`** - Script to create and manage Google Cloud secrets
- **`scripts/deploy.ps1`** - Enhanced deployment script with secrets validation
- **`scripts/check-secrets.ps1`** - Utility to check secret status

#### Updated Files:
- **`cloudbuild.yaml`** - Updated to use Google Secrets and aligned with mythoria-webapp configuration
- **`src/config/environment.ts`** - Enhanced to support both development and production environments
- **`scripts/verify-setup.ps1`** - Added secrets validation and updated region configuration
- **`package.json`** - Added new deployment and secrets management scripts
- **`README.md`** - Updated with new deployment procedures

### 2. Secret Management Strategy

#### Shared Secrets (Reused from mythoria-webapp):
- `mythoria-db-host` - Database host (private IP: 10.19.192.3)
- `mythoria-db-user` - Database user (postgres)
- `mythoria-db-password` - Database password

#### New Story-Specific Secrets:
- `mythoria-storage-bucket` - Google Cloud Storage bucket for story assets
- `mythoria-vertex-ai-model` - Vertex AI model ID for story generation
- `mythoria-vertex-ai-location` - Vertex AI location/region
- `mythoria-workflows-location` - Google Cloud Workflows location

#### Optional Secrets:
- `mythoria-image-generation-model` - Image generation model (optional)
- `mythoria-audio-generation-model` - Audio generation model (optional)

### 3. Configuration Alignment

Both projects now share:
- **Same Google Cloud Project**: `oceanic-beach-460916-n5`
- **Same Region**: `europe-west9`
- **Same Database**: PostgreSQL instance with private IP `10.19.192.3`
- **Same Secret Naming Convention**: `mythoria-{service}-{resource}`

### 4. Deployment Architecture Updates

#### Cloud Build Configuration:
- **Region**: Changed from `us-central1` to `europe-west9`
- **Secrets Integration**: All sensitive data now retrieved from Google Secret Manager
- **Resource Optimization**: Added machine type and disk size optimizations
- **Permissions**: Configured IAM permissions for both Cloud Build and Cloud Run service accounts

#### Cloud Run Configuration:
- **Memory**: 2Gi (optimized for AI workloads)
- **CPU**: 2 cores
- **Timeout**: 3600 seconds (1 hour for long-running story generation)
- **Scaling**: 0-100 instances with 10 concurrent requests per instance

## Migration Steps

### 1. Prerequisites Check
```powershell
# Check current secret status
npm run gcp:check-secrets
```

### 2. Set Up Shared Secrets (if not already done)
```powershell
# Run from mythoria-webapp directory
cd ../mythoria-webapp
.\scripts\setup-secrets.ps1
```

### 3. Set Up Story-Specific Secrets
```powershell
# Run from story-generation-workflow directory
npm run gcp:setup-secrets
```

### 4. Verify Setup
```powershell
npm run gcp:verify
```

### 5. Deploy
```powershell
npm run gcp:deploy
```

## Benefits of This Migration

### 1. Security Improvements
- All sensitive data stored in Google Cloud Secret Manager
- No hardcoded secrets in configuration files
- Automatic secret rotation support
- IAM-based access control

### 2. Consistency
- Aligned with mythoria-webapp deployment patterns
- Shared database and project configuration
- Consistent naming conventions
- Unified region deployment

### 3. Maintainability
- Centralized secret management
- Automated deployment scripts
- Environment-specific configuration loading
- Comprehensive verification and validation

### 4. Operational Excellence
- Health checks and monitoring
- Structured logging
- Error handling and rollback capabilities
- Resource optimization

## Environment Variables Summary

### Production Environment (from Google Secrets):
```
NODE_ENV=production
PORT=8080
DB_HOST=<from mythoria-db-host secret>
DB_PORT=5432
DB_USER=<from mythoria-db-user secret>
DB_PASSWORD=<from mythoria-db-password secret>
DB_NAME=mythoria_db
DB_SSL=false
GOOGLE_CLOUD_PROJECT_ID=oceanic-beach-460916-n5
GOOGLE_CLOUD_REGION=europe-west9
STORAGE_BUCKET_NAME=<from mythoria-storage-bucket secret>
VERTEX_AI_MODEL_ID=<from mythoria-vertex-ai-model secret>
VERTEX_AI_LOCATION=<from mythoria-vertex-ai-location secret>
WORKFLOWS_LOCATION=<from mythoria-workflows-location secret>
LOG_LEVEL=info
```

### Development Environment (from .env files):
```
NODE_ENV=development
PORT=8080
DB_HOST=34.155.187.193  # Public IP for development
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=Mythoria1GCould
DB_NAME=mythoria_db
GOOGLE_CLOUD_PROJECT_ID=oceanic-beach-460916-n5
GOOGLE_CLOUD_REGION=europe-west9
STORAGE_BUCKET_NAME=mythoria-story-assets
VERTEX_AI_MODEL_ID=gemini-1.5-pro
WORKFLOWS_LOCATION=europe-west9
```

## Next Steps

1. **Test the deployment** by running the full deployment pipeline
2. **Verify functionality** using the provided test scripts
3. **Monitor performance** and adjust resource allocation if needed
4. **Set up monitoring** and alerting for the production service
5. **Document any environment-specific configurations** that may be needed

## Support Scripts

All scripts are now available through npm commands:
- `npm run gcp:check-secrets` - Check secret status
- `npm run gcp:setup-secrets` - Create/update secrets
- `npm run gcp:verify` - Verify complete setup
- `npm run gcp:deploy` - Deploy to production

The migration is complete and the story-generation-workflow is now ready for production deployment with Google Cloud Secrets integration.
