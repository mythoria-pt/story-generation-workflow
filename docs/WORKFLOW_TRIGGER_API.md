# Workflow Trigger API

## Overview

The workflow trigger API allows you to start the complete story generation workflow with a single request. This is useful for testing and integrating with external systems.

## Endpoints

### POST /api/workflow/start

Triggers the complete story generation workflow for a given story and run ID.

**Request Body:**
```json
{
  "storyId": "6da9576a-85b6-44e2-824c-1fbfb20ba970",
  "runId": "2eaa716a-2b3a-4388-8f0b-9b3880ffa2c6",
  "prompt": "Optional initial story prompt"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Story generation workflow started successfully",
  "storyId": "6da9576a-85b6-44e2-824c-1fbfb20ba970",
  "runId": "2eaa716a-2b3a-4388-8f0b-9b3880ffa2c6",
  "executionId": "abc123-def456-ghi789",
  "workflowName": "story-generation",
  "status": "started"
}
```

### GET /api/workflow/status/:executionId

Check the status of a workflow execution.

**Response:**
```json
{
  "success": true,
  "executionId": "abc123-def456-ghi789",
  "status": "running",
  "startTime": "2024-06-14T10:00:00.000Z",
  "endTime": null,
  "result": null,
  "error": null
}
```

## Usage Examples

### Using cURL

```bash
# Start the workflow
curl -X POST http://localhost:8080/api/workflow/start \
  -H "Content-Type: application/json" \
  -d '{
    "storyId": "6da9576a-85b6-44e2-824c-1fbfb20ba970",
    "runId": "2eaa716a-2b3a-4388-8f0b-9b3880ffa2c6",
    "prompt": "A fantasy adventure about a young wizard discovering their powers"
  }'

# Check workflow status (replace EXECUTION_ID with the actual ID returned from start)
curl http://localhost:8080/api/workflow/status/EXECUTION_ID
```

### Using PowerShell

```powershell
# Start the workflow
$body = @{
    storyId = "6da9576a-85b6-44e2-824c-1fbfb20ba970"
    runId = "2eaa716a-2b3a-4388-8f0b-9b3880ffa2c6"
    prompt = "A fantasy adventure about a young wizard discovering their powers"
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "http://localhost:8080/api/workflow/start" -Method POST -Body $body -ContentType "application/json"
Write-Output $response

# Check workflow status
$executionId = $response.executionId
$statusResponse = Invoke-RestMethod -Uri "http://localhost:8080/api/workflow/status/$executionId" -Method GET
Write-Output $statusResponse
```

### Using Node.js Test Script

Run the provided test script:

```bash
node test-workflow-trigger.js
```

## Workflow Process

When you trigger the workflow, it will:

1. **Initialize** - Parse the event and set up constants
2. **Generate Outline** - Create the story outline using AI
3. **Write Chapters** - Generate all chapters in parallel
4. **Generate Images** - Create illustrations for each chapter
5. **Assemble** - Combine everything into HTML and PDF
6. **TTS (Optional)** - Generate audio narration
7. **Complete** - Mark the workflow as completed

## Status Values

- `pending` - Workflow is queued but not started
- `running` - Workflow is currently executing
- `completed` - Workflow finished successfully
- `failed` - Workflow encountered an error

## Notes

- The workflow uses Google Cloud Workflows behind the scenes
- All UUIDs should be valid UUID v4 format
- The story and run should exist in the database before triggering
- The workflow runs asynchronously - use the status endpoint to monitor progress
