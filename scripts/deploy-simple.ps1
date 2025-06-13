# Simplified Deploy Story Generation Workflow to Google Cloud
# This script deploys directly to production without secrets check, build, or linting

param(
    [Parameter(Mandatory=$false)]
    [string]$ProjectId
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

Write-Host "SIMPLIFIED DEPLOYMENT - Story Generation Workflow to Google Cloud..." -ForegroundColor Magenta
Write-Host "Project: $ProjectId" -ForegroundColor Cyan
Write-Host "WARNING: Skipping secrets check, build verification, and linting!" -ForegroundColor Yellow

# Validate required environment variables
if (-not $ProjectId) {
    Write-Err "ProjectId not found in command-line parameters or GOOGLE_CLOUD_PROJECT_ID in .env.production file."
    exit 1
}

# Set the Google Cloud project
Write-Info "Setting Google Cloud project..."
gcloud config set project $ProjectId

# Enable required APIs (minimal set)
Write-Info "Enabling required APIs..."
$requiredApis = @(
    "cloudbuild.googleapis.com",
    "run.googleapis.com"
)

foreach ($api in $requiredApis) {
    Write-Host "  Enabling $api..." -ForegroundColor Yellow
    gcloud services enable $api --quiet
}

# Change to project root directory for build
Push-Location $PSScriptRoot\..

try {
    # Create a simplified cloudbuild.yaml for direct deployment
    $simplifiedCloudBuild = @"
steps:
  # Build Docker image
  - name: 'gcr.io/cloud-builders/docker'
    args: ['build', '-t', 'gcr.io/$PROJECT_ID/story-generation-workflow:latest', '.']
  
  # Push Docker image
  - name: 'gcr.io/cloud-builders/docker'
    args: ['push', 'gcr.io/$PROJECT_ID/story-generation-workflow:latest']
  
  # Deploy to Cloud Run
  - name: 'gcr.io/google.com/cloudsdktool/cloud-sdk'
    entrypoint: gcloud
    args:
      - 'run'
      - 'deploy'
      - 'story-generation-workflow'
      - '--image=gcr.io/$PROJECT_ID/story-generation-workflow:latest'
      - '--region=europe-west9'
      - '--platform=managed'
      - '--allow-unauthenticated'
      - '--port=8080'
      - '--memory=2Gi'
      - '--cpu=2'
      - '--min-instances=0'
      - '--max-instances=10'
      - '--timeout=300'

options:
  logging: CLOUD_LOGGING_ONLY
"@

    # Write simplified cloudbuild.yaml
    $simplifiedCloudBuild | Out-File -FilePath "cloudbuild-simple.yaml" -Encoding UTF8
    Write-Info "Created simplified cloudbuild-simple.yaml"
    
    # Submit the simplified build
    Write-Info "Submitting simplified build to Google Cloud Build..."
    Write-Host "This may take several minutes..." -ForegroundColor Yellow
    
    $buildResult = gcloud builds submit --config cloudbuild-simple.yaml 2>&1
    $buildExitCode = $LASTEXITCODE
    
    if ($buildExitCode -eq 0) {
        Write-Success "Simplified deployment completed successfully!"
        Write-Host ""
        Write-Host "Your Story Generation Workflow is now deployed!" -ForegroundColor Green
        Write-Host ""
        Write-Host "Next steps:" -ForegroundColor Cyan
        Write-Host "1. Test the health endpoint: curl https://YOUR-SERVICE-URL/health"
        Write-Host "2. Check the Cloud Run service: gcloud run services describe story-generation-workflow --region=europe-west9"
        Write-Host ""
        Write-Host "Cloud Run URL:" -ForegroundColor Cyan
        try {
            $serviceUrl = gcloud run services describe story-generation-workflow --region=europe-west9 --format="value(status.url)" 2>$null
            if ($serviceUrl) {
                Write-Host $serviceUrl -ForegroundColor Green
                Write-Host ""
                Write-Host "Health check URL: ${serviceUrl}/health" -ForegroundColor Cyan
            } else {
                Write-Warn "Could not retrieve service URL. Check deployment status manually."
            }
        } catch {
            Write-Warn "Could not retrieve service URL. Check deployment status manually."
        }
    } else {
        Write-Err "Simplified deployment failed!"
        Write-Host "Build output:" -ForegroundColor Red
        Write-Host $buildResult -ForegroundColor Red
        exit 1
    }
}
finally {
    # Clean up temporary file
    if (Test-Path "cloudbuild-simple.yaml") {
        Remove-Item "cloudbuild-simple.yaml" -Force
        Write-Info "Cleaned up temporary cloudbuild-simple.yaml"
    }
    Pop-Location
}

Write-Host ""
Write-Host "REMINDER: This was a simplified deployment!" -ForegroundColor Yellow
Write-Host "- No secrets validation was performed" -ForegroundColor Yellow
Write-Host "- No build verification was performed" -ForegroundColor Yellow
Write-Host "- No linting was performed" -ForegroundColor Yellow
Write-Host "Consider running the full deployment script for production!" -ForegroundColor Yellow
