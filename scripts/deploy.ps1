# Deploy Story Generation Workflow to Google Cloud
# This script deploys the application using Google Cloud Build and the updated cloudbuild.yaml configuration

param(
    [Parameter(Mandatory=$false)]
    [string]$ProjectId,
    
    [Parameter(Mandatory=$false)]
    [switch]$SkipSecretsCheck,
    
    [switch]$Fast
)

# Console helper functions
function Write-Info     { param([string]$Msg) Write-Host "[INFO] $Msg" -ForegroundColor Blue  }
function Write-Success  { param([string]$Msg) Write-Host "[SUCCESS] $Msg" -ForegroundColor Green }
function Write-Warn     { param([string]$Msg) Write-Host "[WARN] $Msg" -ForegroundColor Yellow }
function Write-Err      { param([string]$Msg) Write-Host "[ERROR] $Msg" -ForegroundColor Red   }

function Import-EnvironmentVariables {
    Write-Info "Loading environment variables from .env.production..."
    
    # Change to project root directory
    Push-Location $PSScriptRoot\..
    
    try {
        $envFile = '.env.production'
        
        if (Test-Path $envFile) {
            Write-Info "Loading environment variables from: $envFile"
            
            # Read and parse the environment file
            Get-Content $envFile | Where-Object { 
                $_.Trim() -and -not $_.StartsWith('#') 
            } | ForEach-Object {
                if ($_ -match '^([^=]+)=(.*)$') {
                    $name = $matches[1].Trim()
                    $value = $matches[2].Trim()
                    
                    # Remove quotes if present
                    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or 
                        ($value.StartsWith("'") -and $value.EndsWith("'"))) {
                        $value = $value.Substring(1, $value.Length - 2)
                    }
                    
                    # Set environment variable for current session
                    Set-Item -Path "env:$name" -Value $value
                    Write-Host "  [OK] Loaded: $name" -ForegroundColor Green
                }
            }
            
            Write-Success "Environment variables loaded from $envFile"
        } else {
            Write-Warn "No .env.production file found. Using command-line parameters only."
        }
    }
    finally {
        Pop-Location
    }
}

# Load environment variables first
Import-EnvironmentVariables

# Use loaded environment variables or command-line parameters (parameters take precedence)
$ProjectId = if ($ProjectId) { $ProjectId } else { $env:GOOGLE_CLOUD_PROJECT_ID }
$Region = "europe-west9"
$ServiceName = "story-generation-workflow"
$ImageName = "gcr.io/$ProjectId/$ServiceName"

Write-Host "Deploying Story Generation Workflow to Google Cloud..." -ForegroundColor Green
Write-Host "Project: $ProjectId" -ForegroundColor Cyan

# Validate required environment variables
if (-not $ProjectId) {
    Write-Err "ProjectId not found in command-line parameters or GOOGLE_CLOUD_PROJECT_ID in .env.production file."
    exit 1
}

# Set the Google Cloud project
Write-Info "Setting Google Cloud project..."
gcloud config set project $ProjectId

# Check if secrets exist (unless skipped)
if (-not $SkipSecretsCheck) {
    Write-Info "Checking required secrets..."
    $requiredSecrets = @(
        "mythoria-db-host",
        "mythoria-db-user",
        "mythoria-db-password",
        "mythoria-storage-bucket",
        "mythoria-vertex-ai-model",
        "mythoria-vertex-ai-location",
        "mythoria-workflows-location"
    )
    
    $missingSecrets = @()
    foreach ($secret in $requiredSecrets) {
        try {
            $exists = gcloud secrets describe $secret --format="value(name)" 2>$null
            if (-not $exists) {
                $missingSecrets += $secret
            } else {
                Write-Host "  [OK] $secret" -ForegroundColor Green
            }
        } catch {
            $missingSecrets += $secret
        }
    }
    
    if ($missingSecrets.Count -gt 0) {
        Write-Err "Missing required secrets: $($missingSecrets -join ', ')"
        Write-Info "Run .\scripts\setup-secrets.ps1 first to create the secrets"
        exit 1
    }
    
    Write-Success "All required secrets found"
}

# Enable required APIs
Write-Info "Enabling required APIs..."
$requiredApis = @(
    "cloudbuild.googleapis.com",
    "run.googleapis.com",
    "workflows.googleapis.com",
    "secretmanager.googleapis.com",
    "aiplatform.googleapis.com"
)

foreach ($api in $requiredApis) {
    Write-Host "  Enabling $api..." -ForegroundColor Yellow
    gcloud services enable $api
}

# Change to project root directory for build
Push-Location $PSScriptRoot\..

try {
    if ($Fast) {
        Write-Info "Fast deploy: reusing last built image"
        $digest = (gcloud container images list-tags $ImageName --format="get(digest)" --limit=1 --sort-by=~timestamp 2>$null)
        if (-not $digest) {
            Write-Err "No prior image found for $ImageName. Fast deploy requires an existing image."
            exit 1
        }
        $imageRef = "$ImageName@sha256:$digest"
        Write-Info "Deploying $imageRef to $ServiceName in $Region"
        gcloud run deploy $ServiceName --image $imageRef --region $Region --platform managed --quiet
    } else {
        Write-Info "Installing dependencies (npm ci)"
        npm ci
        if ($LASTEXITCODE -ne 0) { Write-Err "npm ci failed"; exit 1 }
        Write-Info "Linting (npm run lint)"
        npm run lint
        if ($LASTEXITCODE -ne 0) { Write-Err "Lint failed"; exit 1 }
        Write-Info "Typecheck (npm run typecheck)"
        npm run typecheck
        if ($LASTEXITCODE -ne 0) { Write-Err "Typecheck failed"; exit 1 }
        Write-Info "Tests (npm test)"
        npm test
        if ($LASTEXITCODE -ne 0) { Write-Err "Tests failed"; exit 1 }
        Write-Info "Building (npm run build)"
        npm run build
        if ($LASTEXITCODE -ne 0) { Write-Err "Build failed"; exit 1 }
        # Submit the build
        Write-Info "Submitting build to Google Cloud Build (beta)..."
        Write-Host "This may take several minutes..." -ForegroundColor Yellow
        
        $buildResult = gcloud beta builds submit --config cloudbuild.yaml 2>&1
        $buildExitCode = $LASTEXITCODE
        
        if ($buildExitCode -ne 0) {
            Write-Err "Deployment failed"
            Write-Host "Build output:" -ForegroundColor Red
            Write-Host $buildResult -ForegroundColor Red
            exit 1
        }
    }

    Write-Success "Deployment completed successfully!"
    Write-Host ""
    Write-Host "Cloud Run URL:" -ForegroundColor Cyan
    gcloud run services describe $ServiceName --region=$Region --format="value(status.url)"
}
finally {
    Pop-Location
}
