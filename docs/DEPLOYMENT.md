# Deployment Guide

Use this guide when promoting Story Generation Workflow to Google Cloud Run and Workflows. Keep the sibling `mythoria-webapp` repo handy for schema changes and shared secrets.

## Prerequisites

| Item                 | Notes                                                                                                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google Cloud project | `oceanic-beach-460916-n5`, region `europe-west9`                                                                                                                                                                |
| Service account      | `wf-story-gen-sa@oceanic-beach-460916-n5.iam.gserviceaccount.com` with `roles/run.admin`, `roles/workflows.invoker`, `roles/aiplatform.user`, `roles/storage.objectAdmin`, `roles/secretmanager.secretAccessor` |
| Artifact Registry    | `europe-west9-docker.pkg.dev/oceanic-beach-460916-n5/mythoria/story-generation-workflow`                                                                                                                        |
| Required APIs        | `run`, `workflows`, `cloudbuild`, `aiplatform`, `secretmanager`, `pubsub`, `eventarc`, `storage`                                                                                                                |
| Deployment machine   | Docker, gcloud CLI, and PowerShell installed                                                                                                                                                                    |

## Release workflow

```powershell
pwsh -NoProfile -Command "npm run lint; npm run typecheck; npm test"
pwsh -NoProfile -Command "npm run build"
pwsh -NoProfile -Command "npm run deploy"   # container + workflow
```

`npm run deploy` wraps `scripts/deploy.ps1`: builds the container, pushes to Artifact Registry, deploys Cloud Run, then deploys updated workflow YAML. Use `npm run deploy:fast` when only the YAML changed.

## Cloud Run configuration

| Setting           | Value                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Service           | `story-generation-workflow`                                                                                                                                        |
| Region            | `europe-west9`                                                                                                                                                     |
| Min/Max instances | 0 / auto                                                                                                                                                           |
| CPU/Memory        | 2 vCPU / 2 GiB (increase to 4 GiB when running heavy CMYK conversions)                                                                                             |
| Env vars          | `NODE_ENV=production`, `PORT=8080`, `GOOGLE_CLOUD_PROJECT_ID`, `GOOGLE_CLOUD_REGION`, `TEXT_PROVIDER`, `IMAGE_PROVIDER`, `STORY_GENERATION_WORKFLOW_API_KEY`, etc. |
| Secrets           | Map DB creds, storage bucket, AI keys, Ghostscript path via Secret Manager; never bake secrets into the image.                                                     |

Recommended secret bindings:

| Secret                                              | Purpose                             |
| --------------------------------------------------- | ----------------------------------- |
| `mythoria-db-host/user/password`                    | Primary PostgreSQL connection       |
| `mythoria-workflows-db-*`                           | Workflow DB connection              |
| `mythoria-storage-bucket`                           | `STORAGE_BUCKET_NAME`               |
| `mythoria-genai-api-key`, `mythoria-openai-api-key` | AI providers                        |
| `story-generation-api-key`                          | `STORY_GENERATION_WORKFLOW_API_KEY` |

## Workflows + Pub/Sub

- `workflows/story-generation.yaml`, `workflows/audiobook-generation.yaml`, `workflows/print-generation.yaml` define orchestration. Deploy them with:

```powershell
pwsh -NoProfile -Command "gcloud workflows deploy mythoria-story-generation --source workflows/story-generation.yaml --location europe-west9 --service-account wf-story-gen-sa@oceanic-beach-460916-n5.iam.gserviceaccount.com"
```

- Pub/Sub topic: `mythoria-story-requests`. Eventarc trigger connects the topic to the `story-generation` workflow. Ensure Eventarc uses the same service account so workflow invocations succeed.

## Verification checklist

1. **Smoke tests**
   - `curl -H "x-api-key: $STORY_GENERATION_WORKFLOW_API_KEY" https://<run-url>/ping` returns 200.
   - `GET /health` shows `database`, `storage`, and `workflows` statuses `ok`.
2. **Workflow execution**
   - Run `pwsh -NoProfile -Command "npm run execute-workflow -- --storyId=test --runId=test"` and confirm `story_generation_runs` status becomes `completed`.
3. **Print pipeline**
   - Call `/internal/print/generate` for a small story, verify RGB + CMYK PDFs appear under `{storyId}/final/` in the bucket.
4. **Audio**
   - Hit `/audio/create-audiobook` with a known story. Workflow should enqueue chapter jobs and write chapter-level `audioUri` fields.
5. **Logs**
   - `pwsh -NoProfile -Command "npm run logs -- --limit 50"` should show structured JSON with `deploymentRevision` matching the current git SHA.

## Rollback

```powershell
# Route 100% traffic to previous revision
pwsh -NoProfile -Command "gcloud run services update-traffic story-generation-workflow --to-revisions <REVISION>=100 --region europe-west9"

# Re-deploy previous workflow file if YAML was the culprit
pwsh -NoProfile -Command "gcloud workflows deploy mythoria-story-generation --source workflows/story-generation.yaml.backup --location europe-west9"
```

Keep the last known-good container tag (e.g., `:2025-11-15`) so you can redeploy without rebuilding.

## Monitoring & alerts

- **Logs**: `pwsh -NoProfile -Command "npm run logs:tail"` streams Cloud Run logs. Look for `status=blocked` to monitor safety issues.
- **Metrics**: Create alerting policies on `run.googleapis.com/request_count`, `error_count`, and `container/memory/utilization`. For workflows, use `gcloud workflows executions list --locations europe-west9 --workflow mythoria-story-generation` to monitor failures.
- **DB hygiene**: Follow the cleanup plan in `docs/development.md#operational-hygiene` to purge stale workflow rows until a scheduled job is deployed.

## Disaster recovery

1. **Database** – Mythoria webapp team manages point-in-time recovery; monitor `story_generation_runs` for backlog spikes post-restore.
2. **Storage** – Bucket `mythoria-story-assets-backup-europe-west9` mirrors production via lifecycle rules. Restore with `gsutil -m rsync -r gs://backup gs://primary`.
3. **Ghostscript/ICC assets** – The Docker image downloads ICC profiles during build; verify `npm run setup-icc-profiles` completes before baking new images.

## Troubleshooting quick answers

| Symptom                             | Likely cause                              | Triage                                                                                 |
| ----------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------- |
| Workflow stuck on `generate_images` | Safety block returning 422                | Check Cloud Run logs for `promptRewriteAttempted`; ensure `GOOGLE_GENAI_API_KEY` valid |
| Print step fails                    | Ghostscript missing / temp dir unwritable | Confirm `GHOSTSCRIPT_BINARY` env var and `TEMP_DIR` permissions                        |
| `/audio/create-audiobook` 500       | Workflow permissions revoked              | Reapply `roles/workflows.invoker` to service account                                   |
| API returns 401                     | `x-api-key` mismatch                      | Confirm secret `story-generation-api-key` mount and header casing                      |

Need deeper context? Pair this guide with `docs/overview.md` (what runs where) and `docs/ai.md` (retry + safety expectations) before touching Cloud Run settings.
