param(
    [switch]$SkipTests,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$region = "europe-west9"
$serviceName = "story-generation-workflow"
$projectId = (gcloud config get-value project 2>$null)

if (-not $projectId) {
    Write-Error "Google Cloud project not configured. Run 'gcloud config set project YOUR_PROJECT_ID'"
    exit 1
}

Write-Host "=== Enhanced Mythoria Deployment with CMYK Support ===" -ForegroundColor Cyan
Write-Host "Project: $projectId" -ForegroundColor Yellow
Write-Host "Service: $serviceName" -ForegroundColor Yellow
Write-Host "Region: $region" -ForegroundColor Yellow

# 1. Setup ICC profiles
Write-Host "Setting up ICC profiles..." -ForegroundColor Green
if (-not $DryRun) {
    & "$PSScriptRoot\setup-icc-profiles.ps1"
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "ICC profile setup failed, continuing with deployment"
    }
}

# 2. Optional tests
if (-not $SkipTests) {
    Write-Host "Running tests..." -ForegroundColor Green
    if (-not $DryRun) {
        npm test
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Tests failed, continuing with deployment"
        }
    }
}

# 3. Submit build and deploy via Cloud Build (cloudbuild.yaml)
Write-Host "Submitting build and deploy via Cloud Build (cloudbuild.yaml)..." -ForegroundColor Green
if (-not $DryRun) {
    gcloud beta builds submit --config cloudbuild.yaml
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Cloud Build submission failed!"
        exit 1
    }
}

Write-Host "Deployment completed successfully!" -ForegroundColor Green
Write-Host "CMYK Features Added:" -ForegroundColor Cyan
Write-Host "  - Ghostscript integration for PDF/X-1a conversion" -ForegroundColor White
Write-Host "  - CoatedFOGRA39 ICC profile support" -ForegroundColor White
Write-Host "  - RGB to CMYK color space conversion" -ForegroundColor White
Write-Host "  - Both RGB and CMYK PDF outputs" -ForegroundColor White
Write-Host "  - Enhanced Docker container with print tools" -ForegroundColor White

if (-not $DryRun) {
    $serviceUrl = gcloud run services describe $serviceName --region=$region --format="value(status.url)" 2>$null
    if ($serviceUrl) {
        Write-Host "Service URL: $serviceUrl" -ForegroundColor Green
        Write-Host "Test CMYK conversion endpoint:" -ForegroundColor Yellow
        Write-Host "  POST $serviceUrl/internal/print/generate" -ForegroundColor White
        Write-Host "  { ""storyId"": ""test-id"", ""workflowId"": ""test-workflow"", ""generateCMYK"": true }" -ForegroundColor Gray
    }
}
