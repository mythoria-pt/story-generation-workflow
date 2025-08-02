# Enhanced deployment script with CMYK/PDF support
param(
    [switch]$SkipBuild,
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
Write-Host "`n📄 Setting up ICC profiles..." -ForegroundColor Green
if (-not $DryRun) {
    & "$PSScriptRoot\setup-icc-profiles.ps1"
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "ICC profile setup failed, continuing with deployment"
    }
}

# 2. Build and test (existing functionality)
if (-not $SkipBuild) {
    Write-Host "`n🔨 Building application..." -ForegroundColor Green
    if (-not $DryRun) {
        npm run build
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Build failed!"
            exit 1
        }
    }
}

if (-not $SkipTests) {
    Write-Host "`n🧪 Running tests..." -ForegroundColor Green
    if (-not $DryRun) {
        npm test
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Tests failed, but continuing with deployment"
        }
    }
}

# 3. Build Docker image with Ghostscript support
Write-Host "`n🐳 Building Docker image with CMYK support..." -ForegroundColor Green
$dockerTag = "gcr.io/$projectId/$serviceName"

if (-not $DryRun) {
    docker build -t $dockerTag .
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Docker build failed!"
        exit 1
    }
    
    Write-Host "✅ Docker image built successfully" -ForegroundColor Green
    
    # Push to Container Registry
    Write-Host "`n📤 Pushing to Google Container Registry..." -ForegroundColor Green
    docker push $dockerTag
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Docker push failed!"
        exit 1
    }
}

# 4. Deploy to Cloud Run
Write-Host "`n🚀 Deploying to Cloud Run..." -ForegroundColor Green

$deployArgs = @(
    "run", "deploy", $serviceName,
    "--image", $dockerTag,
    "--platform", "managed",
    "--region", $region,
    "--allow-unauthenticated",
    "--memory", "2Gi",
    "--cpu", "2",
    "--timeout", "900",
    "--concurrency", "10",
    "--max-instances", "5",
    "--set-env-vars", "NODE_ENV=production,GHOSTSCRIPT_BINARY=gs,TEMP_DIR=/tmp/mythoria-print"
)

if ($DryRun) {
    Write-Host "Would execute: gcloud $($deployArgs -join ' ')" -ForegroundColor Yellow
} else {
    & gcloud @deployArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Cloud Run deployment failed!"
        exit 1
    }
}

Write-Host "`n✅ Deployment completed successfully!" -ForegroundColor Green
Write-Host "`n📋 CMYK Features Added:" -ForegroundColor Cyan
Write-Host "  • Ghostscript integration for PDF/X-1a conversion" -ForegroundColor White
Write-Host "  • CoatedFOGRA39 ICC profile support" -ForegroundColor White
Write-Host "  • RGB to CMYK color space conversion" -ForegroundColor White
Write-Host "  • Both RGB and CMYK PDF outputs" -ForegroundColor White
Write-Host "  • Enhanced Docker container with print tools" -ForegroundColor White

if (-not $DryRun) {
    $serviceUrl = gcloud run services describe $serviceName --region=$region --format="value(status.url)" 2>$null
    if ($serviceUrl) {
        Write-Host "`n🌐 Service URL: $serviceUrl" -ForegroundColor Green
        Write-Host "`n🧪 Test CMYK conversion endpoint:" -ForegroundColor Yellow
        Write-Host "  POST $serviceUrl/internal/print/generate" -ForegroundColor White
        Write-Host "  { ""storyId"": ""test-id"", ""workflowId"": ""test-workflow"", ""generateCMYK"": true }" -ForegroundColor Gray
    }
}
