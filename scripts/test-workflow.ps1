# Test the Story Generation Workflow
# This script publishes a test message to trigger the workflow

param(
    [Parameter(Mandatory=$false)]
    [string]$ProjectId = "oceanic-beach-460916-n5",
    
    [Parameter(Mandatory=$false)]
    [string]$TopicName = "mythoria-story-requests",
    
    [Parameter(Mandatory=$false)]
    [string]$Region = "europe-west9"
)

Write-Host "Testing Mythoria Story Generation Workflow..." -ForegroundColor Green
Write-Host "   Project ID: $ProjectId" -ForegroundColor Yellow
Write-Host "   Topic: $TopicName" -ForegroundColor Yellow
Write-Host "   Region: $Region" -ForegroundColor Yellow

# Generate test IDs
$storyId = [System.Guid]::NewGuid().ToString()
$runId = [System.Guid]::NewGuid().ToString()

Write-Host "   Story ID: $storyId" -ForegroundColor Yellow
Write-Host "   Run ID: $runId" -ForegroundColor Yellow

# Create test message
$testMessage = @{
    storyId = $storyId
    runId = $runId
} | ConvertTo-Json -Compress

Write-Host "Publishing test message to Pub/Sub..." -ForegroundColor Blue
Write-Host "   Message: $testMessage" -ForegroundColor Cyan

try {
    # Publish message to Pub/Sub topic
    $result = & gcloud pubsub topics publish $TopicName --message="$testMessage" --project=$ProjectId 2>&1
    
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to publish message: $result"
    }
    
    Write-Host "[OK] Message published successfully!" -ForegroundColor Green
    Write-Host "   Message ID: $result" -ForegroundColor Yellow
    
    Write-Host ""
    Write-Host "Monitoring workflow execution..." -ForegroundColor Blue
    Write-Host "You can monitor the workflow execution with:" -ForegroundColor Cyan
    Write-Host "   gcloud workflows executions list --workflow=mythoria-story-generation --location=$Region --project=$ProjectId" -ForegroundColor Gray
    
    Write-Host ""
    Write-Host "Wait a few moments, then check execution details:" -ForegroundColor Cyan
    Start-Sleep -Seconds 5
    
    # List recent workflow executions
    Write-Host "Recent workflow executions:" -ForegroundColor Blue
    & gcloud workflows executions list --workflow=mythoria-story-generation --location=$Region --project=$ProjectId --limit=5
    
} catch {
    Write-Error "[ERR] Failed to publish test message: $_"
    exit 1
}

Write-Host ""
Write-Host "Test completed! Check the workflow execution logs for detailed results." -ForegroundColor Green
Write-Host "If you need to debug, check:" -ForegroundColor Yellow
Write-Host "   1. Cloud Run service logs" -ForegroundColor Gray
Write-Host "   2. Workflow execution details" -ForegroundColor Gray
Write-Host "   3. Database records for story generation runs" -ForegroundColor Gray
