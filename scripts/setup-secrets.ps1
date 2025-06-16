# Setup Google Cloud Secret Manager secrets for Story Generation Workflow
# This script extends the existing mythoria-webapp secrets and adds story-specific secrets
# Run this script to create the additional required secrets in Google Cloud Secret Manager

param(
    [Parameter(Mandatory=$false)]
    [string]$ProjectId,
    
    [Parameter(Mandatory=$false)]
    [string]$StorageBucketName,
    
    [Parameter(Mandatory=$false)]
    [string]$VertexAiModelId
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
$StorageBucketName = if ($StorageBucketName) { $StorageBucketName } else { $env:STORAGE_BUCKET_NAME }
$VertexAiModelId = if ($VertexAiModelId) { $VertexAiModelId } else { $env:VERTEX_AI_MODEL_ID }

# Additional secrets from environment
$VertexAiLocation = $env:VERTEX_AI_LOCATION
$WorkflowsLocation = $env:WORKFLOWS_LOCATION
$ImageGenerationModel = $env:IMAGE_GENERATION_MODEL
$AudioGenerationModel = $env:AUDIO_GENERATION_MODEL

Write-Host "Setting up Google Cloud Secret Manager secrets for Story Generation Workflow in project: $ProjectId" -ForegroundColor Green

# Validate required environment variables
if (-not $ProjectId) {
    Write-Err "ProjectId not found in command-line parameters or GOOGLE_CLOUD_PROJECT_ID in .env.production file."
    exit 1
}
if (-not $StorageBucketName) {
    Write-Err "STORAGE_BUCKET_NAME not found in .env.production file or command-line parameters."
    exit 1
}
if (-not $VertexAiModelId) {
    Write-Err "VERTEX_AI_MODEL_ID not found in .env.production file or command-line parameters."
    exit 1
}

# Display loaded configuration
Write-Info "Configuration loaded:"
Write-Host "  [OK] PROJECT_ID: $ProjectId" -ForegroundColor Green
Write-Host "  [OK] STORAGE_BUCKET_NAME: $StorageBucketName" -ForegroundColor Green
Write-Host "  [OK] VERTEX_AI_MODEL_ID: $VertexAiModelId" -ForegroundColor Green
Write-Host "  [OK] VERTEX_AI_LOCATION: $VertexAiLocation" -ForegroundColor Green
Write-Host "  [OK] WORKFLOWS_LOCATION: $WorkflowsLocation" -ForegroundColor Green
if ($ImageGenerationModel) { Write-Host "  [OK] IMAGE_GENERATION_MODEL: $ImageGenerationModel" -ForegroundColor Green }
if ($AudioGenerationModel) { Write-Host "  [OK] AUDIO_GENERATION_MODEL: $AudioGenerationModel" -ForegroundColor Green }

# Set the Google Cloud project
Write-Host "Setting Google Cloud project..." -ForegroundColor Blue
gcloud config set project $ProjectId

# Enable Secret Manager API if not already enabled
Write-Host "Enabling Secret Manager API..." -ForegroundColor Blue
gcloud services enable secretmanager.googleapis.com

# Check if database secrets already exist (from mythoria-webapp)
Write-Info "Checking existing database secrets from mythoria-webapp..."
$existingSecrets = @()
try {
    $dbHostSecret = gcloud secrets describe mythoria-db-host --format="value(name)" 2>$null
    if ($dbHostSecret) {
        $existingSecrets += "mythoria-db-host"
        Write-Success "Database secrets already exist from mythoria-webapp - reusing them"
    }
} catch {
    Write-Warn "Database secrets not found - they may need to be created by running mythoria-webapp setup first"
}

# Create story-generation-workflow specific secrets
# Note: The following variables have been moved to environment variables in cloudbuild.yaml:
# - mythoria-generated-stories-bucket (now STORAGE_BUCKET_NAME)
# - mythoria-audio-generation-model (now AUDIO_GENERATION_MODEL)
# - mythoria-image-generation-model (now IMAGE_GENERATION_MODEL)
# - mythoria-workflows-location (now WORKFLOWS_LOCATION)  
# - mythoria-vertex-ai-location (now VERTEX_AI_LOCATION)
# - mythoria-vertex-ai-model (now VERTEX_AI_MODEL_ID)
# - mythoria-storage-bucket (now STORAGE_BUCKET_NAME)

Write-Info "All story-generation-workflow configuration is now handled via environment variables in cloudbuild.yaml"
Write-Info "Only sensitive database and API key secrets remain in Secret Manager"

# Grant permissions to Cloud Build service account for new secrets
Write-Host "Granting permissions to Cloud Build service account..." -ForegroundColor Blue
$projectNumber = (gcloud projects describe $ProjectId --format='value(projectNumber)')
$cloudBuildServiceAccount = "$projectNumber@cloudbuild.gserviceaccount.com"

$storySecrets = @(
    "mythoria-storage-bucket",
    "mythoria-vertex-ai-model", 
    "mythoria-vertex-ai-location",
    "mythoria-workflows-location"
)

if ($ImageGenerationModel) { $storySecrets += "mythoria-image-generation-model" }
if ($AudioGenerationModel) { $storySecrets += "mythoria-audio-generation-model" }

foreach ($secret in $storySecrets) {
    gcloud secrets add-iam-policy-binding $secret --member="serviceAccount:$cloudBuildServiceAccount" --role="roles/secretmanager.secretAccessor"
}

# Grant permissions to Cloud Run service account (Compute Engine default) for new secrets
Write-Host "Granting permissions to Cloud Run service account..." -ForegroundColor Blue
$computeServiceAccount = "$projectNumber-compute@developer.gserviceaccount.com"

foreach ($secret in $storySecrets) {
    gcloud secrets add-iam-policy-binding $secret --member="serviceAccount:$computeServiceAccount" --role="roles/secretmanager.secretAccessor"
}

Write-Host "[SUCCESS] Story Generation Workflow secrets setup completed successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "Reusing existing secrets from mythoria-webapp:" -ForegroundColor Cyan
Write-Host "  - mythoria-db-host" -ForegroundColor White
Write-Host "  - mythoria-db-user" -ForegroundColor White
Write-Host "  - mythoria-db-password" -ForegroundColor White
Write-Host ""
Write-Host "Created new secrets for story-generation-workflow:" -ForegroundColor Cyan
Write-Host "  - mythoria-storage-bucket" -ForegroundColor White
Write-Host "  - mythoria-vertex-ai-model" -ForegroundColor White
Write-Host "  - mythoria-vertex-ai-location" -ForegroundColor White
Write-Host "  - mythoria-workflows-location" -ForegroundColor White
if ($ImageGenerationModel) { Write-Host "  - mythoria-image-generation-model" -ForegroundColor White }
if ($AudioGenerationModel) { Write-Host "  - mythoria-audio-generation-model" -ForegroundColor White }

Write-Host ""
Write-Host "To verify all secrets were created, run:" -ForegroundColor Cyan
Write-Host "  gcloud secrets list --filter='name~mythoria'" -ForegroundColor White
Write-Host ""
Write-Host "To update a secret value later, run:" -ForegroundColor Cyan
Write-Host "  'NEW_VALUE' | Set-Content -Path temp.txt -NoNewline; gcloud secrets versions add SECRET_NAME --data-file=temp.txt; Remove-Item temp.txt" -ForegroundColor White
