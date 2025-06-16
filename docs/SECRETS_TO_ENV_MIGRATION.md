# Migration Guide: Secrets to Environment Variables

This document describes the migration from Google Cloud Secret Manager to environment variables for non-sensitive configuration data.

## What Changed

The following secrets have been converted to environment variables in `cloudbuild.yaml`:

| Old Secret Name | New Environment Variable | Default Value |
|----------------|-------------------------|---------------|
| `mythoria-generated-stories-bucket` | `STORAGE_BUCKET_NAME` | `mythoria-generated-stories` |
| `mythoria-audio-generation-model` | `AUDIO_GENERATION_MODEL` | `tts-1` |
| `mythoria-image-generation-model` | `IMAGE_GENERATION_MODEL` | `dall-e-3` |
| `mythoria-workflows-location` | `WORKFLOWS_LOCATION` | `europe-west9` |
| `mythoria-vertex-ai-location` | `VERTEX_AI_LOCATION` | `europe-west9` |
| `mythoria-vertex-ai-model` | `VERTEX_AI_MODEL_ID` | `gemini-1.5-flash-002` |
| `mythoria-storage-bucket` | `STORAGE_BUCKET_NAME` | `mythoria-generated-stories` |

## What Remains as Secrets

Only sensitive data remains in Google Cloud Secret Manager:

- `mythoria-db-host` - Database connection details
- `mythoria-db-user` - Database credentials
- `mythoria-db-password` - Database credentials  
- `mythoria-openai-api-key` - API keys

## Migration Steps

### 1. Deploy the Updated Configuration

The new configuration is already in place in `cloudbuild.yaml`. Your next deployment will use environment variables instead of secrets for the non-sensitive data.

### 2. Clean Up Old Secrets (Optional)

After successful deployment, you can remove the old secrets:

```powershell
.\scripts\cleanup-old-secrets.ps1 -ProjectId your-project-id
```

### 3. Update Local Development

If you have a local `.env` file, update it to match the new variable names:

```bash
# Copy the updated example
cp .env.example .env
# Edit .env with your specific values
```

## Benefits of This Change

1. **Transparency**: Non-sensitive config is visible in the build file
2. **Simplicity**: Fewer secrets to manage
3. **Version Control**: Configuration changes are tracked in git
4. **Easier Debugging**: Values are visible in build logs
5. **Faster Deployments**: No secret lookups during deployment

## Rollback Plan

If you need to rollback to the previous secret-based approach:

1. Use the backup of the original `cloudbuild.yaml`
2. Run the original `setup-secrets.ps1` script
3. Redeploy the service

## Verification

After migration, verify that:

1. The service deploys successfully
2. All environment variables are correctly set
3. The application functions as expected
4. Old secrets are removed (if cleanup was run)

## Support

If you encounter issues during migration:

1. Check the Cloud Build logs for deployment errors
2. Verify environment variable values in the Cloud Run console
3. Ensure the service starts correctly by checking the application logs
