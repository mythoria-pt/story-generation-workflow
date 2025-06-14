# Deploy Story Generation Workflow to Google Cloud Workflows
# This script deploys the workflow and sets up the Pub/Sub trigger

param(
    [Parameter(Mandatory=$false)]
    [string]$ProjectId = $env:GOOGLE_CLOUD_PROJECT_ID,
    
    [Parameter(Mandatory=$false)]
    [string]$Region = $env:GOOGLE_CLOUD_REGION,
    
    [Parameter(Mandatory=$false)]
    [string]$ServiceAccount = $env:WORKFLOW_SERVICE_ACCOUNT,
    
    [Parameter(Mandatory=$false)]
    [string]$WorkflowName = "mythoria-story-generation",
    
    [Parameter(Mandatory=$false)]
    [string]$TopicName = "mythoria-story-requests"
)

# Check required parameters
if (-not $ProjectId) {
    Write-Error "ProjectId is required. Set GOOGLE_CLOUD_PROJECT_ID environment variable or pass -ProjectId parameter."
    exit 1
}

if (-not $Region) {
    Write-Error "Region is required. Set GOOGLE_CLOUD_REGION environment variable or pass -Region parameter."
    exit 1
}

# Default region if not specified
if (-not $Region) {
    $Region = "europe-west9"
}

Write-Host "Deploying Mythoria Story Generation Workflow..." -ForegroundColor Green
Write-Host "   Project ID: $ProjectId" -ForegroundColor Yellow
Write-Host "   Region: $Region" -ForegroundColor Yellow
Write-Host "   Workflow Name: $WorkflowName" -ForegroundColor Yellow

# 1. Deploy the workflow
Write-Host  "Deploying workflow definition..." -ForegroundColor Blue

$deployArgs = @(
    "workflows", "deploy", $WorkflowName,
    "--source=workflows/story-generation.yaml",
    "--location=$Region",
    "--project=$ProjectId"
)

if ($ServiceAccount) {
    $deployArgs += "--service-account=$ServiceAccount"
    Write-Host "   Service Account: $ServiceAccount" -ForegroundColor Yellow
}

try {
    & gcloud @deployArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Workflow deployment failed"
    }
    Write-Host "[OK] Workflow deployed successfully!" -ForegroundColor Green
} catch {
    Write-Error "[ERR] Failed to deploy workflow: $_"
    exit 1
}

# 2. Create or verify Pub/Sub topic exists
Write-Host "-> Setting up Pub/Sub topic..." -ForegroundColor Blue

try {
    # Check if topic exists
    $topicExists = & gcloud pubsub topics describe $TopicName --project=$ProjectId 2>$null
    
    if ($LASTEXITCODE -ne 0) {
        Write-Host "   Creating Pub/Sub topic: $TopicName" -ForegroundColor Yellow
        & gcloud pubsub topics create $TopicName --project=$ProjectId
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to create Pub/Sub topic"
        }
    } else {
        Write-Host "   Pub/Sub topic already exists: $TopicName" -ForegroundColor Yellow
    }
} catch {
    Write-Error "[ERR] Failed to setup Pub/Sub topic: $_"
    exit 1
}

# 3. Create or update the Pub/Sub trigger
Write-Host "-> Setting up Pub/Sub trigger..." -ForegroundColor Blue

$triggerName = "$WorkflowName-trigger"

try {
    # Check if trigger exists
    $triggerExists = & gcloud eventarc triggers describe $triggerName --location=$Region --project=$ProjectId 2>$null    if ($LASTEXITCODE -ne 0) {
        Write-Host "   Creating Pub/Sub trigger: $triggerName" -ForegroundColor Yellow
        & gcloud eventarc triggers create $triggerName `
            --destination-workflow=$WorkflowName `
            --destination-workflow-location=$Region `
            --event-filters="type=google.cloud.pubsub.topic.v1.messagePublished" `
            --transport-topic="projects/$ProjectId/topics/$TopicName" `
            --service-account="wf-story-gen-sa@$ProjectId.iam.gserviceaccount.com" `
            --location=$Region `
            --project=$ProjectId
            
        if ($LASTEXITCODE -ne 0) {
            throw "[ERR] Failed to create Pub/Sub trigger"
        }
    }else {
        Write-Host "   Pub/Sub trigger already exists: $triggerName" -ForegroundColor Yellow
        Write-Host "   You may need to update it manually if the configuration changed." -ForegroundColor Yellow
    }
} catch {
    Write-Error "[ERR] Failed to setup Pub/Sub trigger: $_"
    exit 1
}

# 4. Grant necessary permissions to the workflow service account
if ($ServiceAccount) {
    Write-Host "[LCK] Setting up service account permissions..." -ForegroundColor Blue
    
    # Get the Cloud Run service URL from environment or use default
    $cloudRunUrl = $env:SGW_SERVICE_URL
    if (-not $cloudRunUrl) {
        $cloudRunUrl = "https://story-generation-workflow-803421888801.europe-west9.run.app"
    }
    
    # Extract service name from URL for Cloud Run Invoker permission
    if ($cloudRunUrl -match "https://([^.]+)") {
        $serviceName = $matches[1]
        
        try {
            Write-Host "   Granting Cloud Run Invoker permission to service: $serviceName" -ForegroundColor Yellow
            & gcloud run services add-iam-policy-binding $serviceName `
                --member="serviceAccount:$ServiceAccount" `
                --role="roles/run.invoker" `
                --region=$Region `
                --project=$ProjectId
                
            if ($LASTEXITCODE -ne 0) {
                Write-Warning "[WARN]  Failed to grant Cloud Run Invoker permission. You may need to do this manually."
            } else {
                Write-Host "   [OK] Cloud Run Invoker permission granted" -ForegroundColor Green
            }
        } catch {
            Write-Warning "[WARN]  Failed to grant Cloud Run Invoker permission: $_"
        }
    }
}

Write-Host ""
Write-Host "Deployment Complete!" -ForegroundColor Green
Write-Host ""
Write-Host "Summary:" -ForegroundColor Cyan
Write-Host "   [OK] Workflow '$WorkflowName' deployed to $Region" -ForegroundColor White
Write-Host "   [OK] Pub/Sub topic '$TopicName' ready" -ForegroundColor White
Write-Host "   [OK] EventaRC trigger '$triggerName' configured" -ForegroundColor White
Write-Host ""
Write-Host "To test the workflow, publish a message to the Pub/Sub topic:" -ForegroundColor Cyan
Write-Host "   gcloud pubsub topics publish $TopicName --message='{\"storyId\":\"test-story-id\",\"runId\":\"test-run-id\"}'" -ForegroundColor Gray
Write-Host ""
Write-Host "Monitor workflow executions:" -ForegroundColor Cyan
Write-Host "   gcloud workflows executions list --workflow=$WorkflowName --location=$Region" -ForegroundColor Gray
Write-Host ""

# Show next steps
Write-Host "Next Steps:" -ForegroundColor Cyan
Write-Host "   1. Ensure your Cloud Run service is deployed and accessible" -ForegroundColor White
Write-Host "   2. Update the baseUrl in the workflow if your Cloud Run URL is different" -ForegroundColor White
Write-Host "   3. Test the workflow with a real story generation request" -ForegroundColor White
Write-Host "   4. Monitor logs and adjust error handling as needed" -ForegroundColor White
