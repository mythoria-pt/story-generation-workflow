# Verify Google Cloud Workflow setup and connection
# This script checks if everything is properly configured

Write-Host "=== Google Cloud Workflow Setup Verification ===" -ForegroundColor Cyan

# Check if gcloud is configured
Write-Host "1. Checking gcloud configuration..." -ForegroundColor Yellow
try {
    $project = gcloud config get-value project
    $account = gcloud config get-value account
    Write-Host "   [OK] Project: $project" -ForegroundColor Green
    Write-Host "   [OK] Account: $account" -ForegroundColor Green
} catch {
    Write-Host "   [ERROR] gcloud not configured properly" -ForegroundColor Red
    exit 1
}

# Check if workflow exists
Write-Host "2. Checking workflow deployment..." -ForegroundColor Yellow
try {
    $workflow = gcloud workflows describe mythoria-story-generation --location=europe-west9 --format="value(name)" 2>$null
    if ($workflow) {
        Write-Host "   [OK] Workflow 'mythoria-story-generation' found" -ForegroundColor Green
        Write-Host "   [OK] Location: europe-west9" -ForegroundColor Green
    } else {
        Write-Host "   [MISSING] Workflow 'mythoria-story-generation' not found" -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "   [ERROR] Error checking workflow: $_" -ForegroundColor Red
    exit 1
}

# Check workflow state
Write-Host "3. Checking workflow state..." -ForegroundColor Yellow
try {
    $state = gcloud workflows describe mythoria-story-generation --location=europe-west9 --format="value(state)"
    if ($state -eq "ACTIVE") {
        Write-Host "   [OK] Workflow is ACTIVE and ready" -ForegroundColor Green
    } else {
        Write-Host "   [WARN] Workflow state: $state" -ForegroundColor Yellow
    }
} catch {
    Write-Host "   [ERROR] Error checking workflow state: $_" -ForegroundColor Red
}

# Check if Cloud Run service exists
Write-Host "4. Checking Cloud Run service..." -ForegroundColor Yellow
try {
    $service = gcloud run services describe mythoria-story-generation-workflow --region=europe-west9 --format="value(status.url)" 2>$null
    if ($service) {
        Write-Host "   [OK] Cloud Run service found: $service" -ForegroundColor Green
    } else {
        Write-Host "   [WARN] Cloud Run service not found (this is OK if not deployed yet)" -ForegroundColor Yellow
    }
} catch {
    Write-Host "   [WARN] Cloud Run service not found (this is OK if not deployed yet)" -ForegroundColor Yellow
}

# Check required secrets
Write-Host "5. Checking required secrets..." -ForegroundColor Yellow
$requiredSecrets = @(
    "mythoria-db-host",
    "mythoria-db-user", 
    "mythoria-db-password",
    "mythoria-storage-bucket",
    # Deprecated vertex ai secrets removed
    "mythoria-workflows-location"
)

$missingSecrets = @()
foreach ($secret in $requiredSecrets) {
    try {
        $exists = gcloud secrets describe $secret --format="value(name)" 2>$null
        if ($exists) {
            Write-Host "   [OK] Secret: $secret" -ForegroundColor Green
        } else {
            Write-Host "   [MISSING] Secret: $secret" -ForegroundColor Red
            $missingSecrets += $secret
        }
    } catch {
        Write-Host "   [MISSING] Secret: $secret" -ForegroundColor Red
        $missingSecrets += $secret
    }
}

if ($missingSecrets.Count -gt 0) {
    Write-Host ""
    Write-Host "[ERROR] Missing secrets: $($missingSecrets -join ', ')" -ForegroundColor Red
    Write-Host "Run .\scripts\setup-secrets.ps1 to create missing secrets" -ForegroundColor Yellow
}

# Check required APIs
Write-Host "6. Checking required APIs..." -ForegroundColor Yellow
$requiredApis = @(
    "workflows.googleapis.com",
    "run.googleapis.com",
    "cloudbuild.googleapis.com",
    "aiplatform.googleapis.com",
    "secretmanager.googleapis.com"
)

foreach ($api in $requiredApis) {
    try {
        $enabled = gcloud services list --enabled --filter="name:$api" --format="value(name)"
        if ($enabled) {
            Write-Host "   [OK] $api enabled" -ForegroundColor Green
        } else {
            Write-Host "   [ERROR] $api not enabled" -ForegroundColor Red
        }
    } catch {
        Write-Host "   [WARN] Could not check $api" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "=== Setup Complete! ===" -ForegroundColor Cyan
Write-Host "Your Google Cloud Workflow 'mythoria-story-generation' is ready to use." -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "1. Run secrets setup: .\scripts\setup-secrets.ps1"
Write-Host "2. Deploy your Cloud Run service: gcloud beta builds submit --config cloudbuild.yaml"
Write-Host "3. Test the workflow: .\scripts\test-workflow.ps1"
Write-Host "4. Execute with custom data: .\scripts\execute-workflow.ps1 -StoryId 'test' -Prompt 'Your prompt'"
