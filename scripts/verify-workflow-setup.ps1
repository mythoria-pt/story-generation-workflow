# Verify Story Generation Workflow Prerequisites and Status
# This script checks if all components are properly configured before deployment

param(
    [Parameter(Mandatory=$false)]
    [string]$ProjectId = $env:GOOGLE_CLOUD_PROJECT_ID,
    
    [Parameter(Mandatory=$false)]
    [string]$Region = $env:GOOGLE_CLOUD_REGION,
    
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
    $Region = "europe-west9"
}

Write-Host "🔍 Verifying Mythoria Story Generation Workflow Setup..." -ForegroundColor Green
Write-Host "   Project ID: $ProjectId" -ForegroundColor Yellow
Write-Host "   Region: $Region" -ForegroundColor Yellow
Write-Host ""

$allGood = $true

# 1. Check if gcloud CLI is installed and authenticated
Write-Host "1️⃣  Checking Google Cloud CLI..." -ForegroundColor Blue
try {
    $gcloudVersion = & gcloud version --format="value(Google Cloud SDK)" 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "   ✅ Google Cloud CLI installed: $gcloudVersion" -ForegroundColor Green
    } else {
        Write-Host "   ❌ Google Cloud CLI not found or not authenticated" -ForegroundColor Red
        $allGood = $false
    }
} catch {
    Write-Host "   ❌ Google Cloud CLI not found" -ForegroundColor Red
    $allGood = $false
}

# 2. Check if project exists and is accessible
Write-Host "2️⃣  Checking project access..." -ForegroundColor Blue
try {
    $projectInfo = & gcloud projects describe $ProjectId --format="value(projectId)" 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "   ✅ Project accessible: $ProjectId" -ForegroundColor Green
    } else {
        Write-Host "   ❌ Cannot access project: $ProjectId" -ForegroundColor Red
        $allGood = $false
    }
} catch {
    Write-Host "   ❌ Cannot access project: $ProjectId" -ForegroundColor Red
    $allGood = $false
}

# 3. Check required APIs
Write-Host "3️⃣  Checking required APIs..." -ForegroundColor Blue
$requiredApis = @(
    "workflows.googleapis.com",
    "workflowexecutions.googleapis.com",
    "pubsub.googleapis.com",
    "eventarc.googleapis.com",
    "run.googleapis.com",
    "cloudbuild.googleapis.com"
)

foreach ($api in $requiredApis) {
    try {
        $apiStatus = & gcloud services list --enabled --filter="name:$api" --format="value(name)" --project=$ProjectId 2>$null
        if ($apiStatus -eq $api) {
            Write-Host "   ✅ API enabled: $api" -ForegroundColor Green
        } else {
            Write-Host "   ❌ API not enabled: $api" -ForegroundColor Red
            Write-Host "      Enable with: gcloud services enable $api --project=$ProjectId" -ForegroundColor Gray
            $allGood = $false
        }
    } catch {
        Write-Host "   ❌ Cannot check API: $api" -ForegroundColor Red
        $allGood = $false
    }
}

# 4. Check if workflow exists
Write-Host "4️⃣  Checking existing workflow..." -ForegroundColor Blue
try {
    $workflowExists = & gcloud workflows describe $WorkflowName --location=$Region --project=$ProjectId --format="value(name)" 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "   ✅ Workflow exists: $WorkflowName" -ForegroundColor Green
        
        # Get workflow status
        $workflowState = & gcloud workflows describe $WorkflowName --location=$Region --project=$ProjectId --format="value(state)" 2>$null
        Write-Host "   📊 Workflow state: $workflowState" -ForegroundColor Yellow
    } else {
        Write-Host "   ⚠️  Workflow not found: $WorkflowName (will be created during deployment)" -ForegroundColor Yellow
    }
} catch {
    Write-Host "   ⚠️  Workflow not found: $WorkflowName (will be created during deployment)" -ForegroundColor Yellow
}

# 5. Check Pub/Sub topic
Write-Host "5️⃣  Checking Pub/Sub topic..." -ForegroundColor Blue
try {
    $topicExists = & gcloud pubsub topics describe $TopicName --project=$ProjectId --format="value(name)" 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "   ✅ Pub/Sub topic exists: $TopicName" -ForegroundColor Green
    } else {
        Write-Host "   ⚠️  Pub/Sub topic not found: $TopicName (will be created during deployment)" -ForegroundColor Yellow
    }
} catch {
    Write-Host "   ⚠️  Pub/Sub topic not found: $TopicName (will be created during deployment)" -ForegroundColor Yellow
}

# 6. Check EventaRC trigger
Write-Host "6️⃣  Checking EventaRC trigger..." -ForegroundColor Blue
$triggerName = "$WorkflowName-trigger"
try {
    $triggerExists = & gcloud eventarc triggers describe $triggerName --location=$Region --project=$ProjectId --format="value(name)" 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "   ✅ EventaRC trigger exists: $triggerName" -ForegroundColor Green
        
        # Get trigger details
        $triggerDestination = & gcloud eventarc triggers describe $triggerName --location=$Region --project=$ProjectId --format="value(destination.workflow.workflow)" 2>$null
        Write-Host "   📊 Trigger destination: $triggerDestination" -ForegroundColor Yellow
    } else {
        Write-Host "   ⚠️  EventaRC trigger not found: $triggerName (will be created during deployment)" -ForegroundColor Yellow
    }
} catch {
    Write-Host "   ⚠️  EventaRC trigger not found: $triggerName (will be created during deployment)" -ForegroundColor Yellow
}

# 7. Check Cloud Run service
Write-Host "7️⃣  Checking Cloud Run service..." -ForegroundColor Blue
$expectedServiceName = "story-generation-workflow"
try {
    $cloudRunServices = & gcloud run services list --region=$Region --project=$ProjectId --format="value(metadata.name)" 2>$null
    if ($cloudRunServices -contains $expectedServiceName) {
        Write-Host "   ✅ Cloud Run service found: $expectedServiceName" -ForegroundColor Green
        
        # Get service URL
        $serviceUrl = & gcloud run services describe $expectedServiceName --region=$Region --project=$ProjectId --format="value(status.url)" 2>$null
        Write-Host "   📊 Service URL: $serviceUrl" -ForegroundColor Yellow
        
        # Check if URL matches what's in the workflow
        $workflowFile = "workflows/story-generation.yaml"
        if (Test-Path $workflowFile) {
            $workflowContent = Get-Content $workflowFile -Raw
            if ($workflowContent -match 'baseUrl:\s*"([^"]+)"') {
                $workflowUrl = $matches[1]
                if ($serviceUrl -eq $workflowUrl) {
                    Write-Host "   ✅ Workflow URL matches Cloud Run service URL" -ForegroundColor Green
                } else {
                    Write-Host "   ⚠️  Workflow URL ($workflowUrl) doesn't match Cloud Run URL ($serviceUrl)" -ForegroundColor Yellow
                    Write-Host "      Update the baseUrl in $workflowFile if needed" -ForegroundColor Gray
                }
            }
        }
    } else {
        Write-Host "   ❌ Cloud Run service not found: $expectedServiceName" -ForegroundColor Red
        Write-Host "      Deploy the service first before running the workflow" -ForegroundColor Gray
        $allGood = $false
    }
} catch {
    Write-Host "   ❌ Cannot check Cloud Run services" -ForegroundColor Red
    $allGood = $false
}

# 8. Check workflow file exists
Write-Host "8️⃣  Checking workflow definition file..." -ForegroundColor Blue
$workflowFile = "workflows/story-generation.yaml"
if (Test-Path $workflowFile) {
    Write-Host "   ✅ Workflow file exists: $workflowFile" -ForegroundColor Green
    
    # Basic syntax check
    try {
        $content = Get-Content $workflowFile -Raw
        if ($content -match "main:\s*\n") {
            Write-Host "   ✅ Workflow file has valid main section" -ForegroundColor Green
        } else {
            Write-Host "   ⚠️  Workflow file may have syntax issues" -ForegroundColor Yellow
        }
    } catch {
        Write-Host "   ⚠️  Cannot read workflow file" -ForegroundColor Yellow
    }
} else {
    Write-Host "   ❌ Workflow file not found: $workflowFile" -ForegroundColor Red
    $allGood = $false
}

# Summary
Write-Host ""
if ($allGood) {
    Write-Host "🎉 All prerequisites met! Ready to deploy." -ForegroundColor Green
    Write-Host ""
    Write-Host "▶️  Run deployment script:" -ForegroundColor Cyan
    Write-Host "   .\scripts\deploy-workflow.ps1" -ForegroundColor Gray
} else {
    Write-Host "❌ Some prerequisites are missing. Please fix the issues above before deployment." -ForegroundColor Red
}

Write-Host ""
Write-Host "🔗 Useful commands:" -ForegroundColor Cyan
Write-Host "   Enable required APIs: gcloud services enable workflows.googleapis.com workflowexecutions.googleapis.com pubsub.googleapis.com eventarc.googleapis.com --project=$ProjectId" -ForegroundColor Gray
Write-Host "   Deploy Cloud Run service: .\scripts\deploy.ps1" -ForegroundColor Gray
Write-Host "   View workflow executions: gcloud workflows executions list --workflow=$WorkflowName --location=$Region --project=$ProjectId" -ForegroundColor Gray
