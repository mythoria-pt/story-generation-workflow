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
Write-Host "Creating storage bucket name secret..." -ForegroundColor Blue
try {
    $secretExists = gcloud secrets describe mythoria-storage-bucket --format="value(name)" 2>$null
    if ($LASTEXITCODE -eq 0 -and $secretExists) {
        Write-Info "Secret mythoria-storage-bucket already exists, updating..."
        $StorageBucketName.Trim() | Set-Content -Path temp_secret.txt -NoNewline; gcloud secrets versions add mythoria-storage-bucket --data-file=temp_secret.txt; Remove-Item temp_secret.txt
    } else {
        Write-Info "Creating new secret mythoria-storage-bucket..."
        $StorageBucketName.Trim() | Set-Content -Path temp_secret.txt -NoNewline; gcloud secrets create mythoria-storage-bucket --data-file=temp_secret.txt --replication-policy='automatic'; Remove-Item temp_secret.txt
    }
} catch {
    Write-Info "Creating new secret mythoria-storage-bucket..."
    $StorageBucketName.Trim() | Set-Content -Path temp_secret.txt -NoNewline; gcloud secrets create mythoria-storage-bucket --data-file=temp_secret.txt --replication-policy='automatic'; Remove-Item temp_secret.txt
}

Write-Host "Creating Vertex AI model ID secret..." -ForegroundColor Blue
try {
    $secretExists = gcloud secrets describe mythoria-vertex-ai-model --format="value(name)" 2>$null
    if ($LASTEXITCODE -eq 0 -and $secretExists) {
        Write-Info "Secret mythoria-vertex-ai-model already exists, updating..."
        $VertexAiModelId.Trim() | Set-Content -Path temp_secret.txt -NoNewline; gcloud secrets versions add mythoria-vertex-ai-model --data-file=temp_secret.txt; Remove-Item temp_secret.txt
    } else {
        Write-Info "Creating new secret mythoria-vertex-ai-model..."
        $VertexAiModelId.Trim() | Set-Content -Path temp_secret.txt -NoNewline; gcloud secrets create mythoria-vertex-ai-model --data-file=temp_secret.txt --replication-policy='automatic'; Remove-Item temp_secret.txt
    }
} catch {
    Write-Info "Creating new secret mythoria-vertex-ai-model..."
    $VertexAiModelId.Trim() | Set-Content -Path temp_secret.txt -NoNewline; gcloud secrets create mythoria-vertex-ai-model --data-file=temp_secret.txt --replication-policy='automatic'; Remove-Item temp_secret.txt
}

Write-Host "Creating Vertex AI location secret..." -ForegroundColor Blue
try {
    $secretExists = gcloud secrets describe mythoria-vertex-ai-location --format="value(name)" 2>$null
    if ($LASTEXITCODE -eq 0 -and $secretExists) {
        Write-Info "Secret mythoria-vertex-ai-location already exists, updating..."
        $VertexAiLocation.Trim() | Set-Content -Path temp_secret.txt -NoNewline; gcloud secrets versions add mythoria-vertex-ai-location --data-file=temp_secret.txt; Remove-Item temp_secret.txt
    } else {
        Write-Info "Creating new secret mythoria-vertex-ai-location..."
        $VertexAiLocation.Trim() | Set-Content -Path temp_secret.txt -NoNewline; gcloud secrets create mythoria-vertex-ai-location --data-file=temp_secret.txt --replication-policy='automatic'; Remove-Item temp_secret.txt
    }
} catch {
    Write-Info "Creating new secret mythoria-vertex-ai-location..."
    $VertexAiLocation.Trim() | Set-Content -Path temp_secret.txt -NoNewline; gcloud secrets create mythoria-vertex-ai-location --data-file=temp_secret.txt --replication-policy='automatic'; Remove-Item temp_secret.txt
}

Write-Host "Creating workflows location secret..." -ForegroundColor Blue
try {
    $secretExists = gcloud secrets describe mythoria-workflows-location --format="value(name)" 2>$null
    if ($LASTEXITCODE -eq 0 -and $secretExists) {
        Write-Info "Secret mythoria-workflows-location already exists, updating..."
        $WorkflowsLocation.Trim() | Set-Content -Path temp_secret.txt -NoNewline; gcloud secrets versions add mythoria-workflows-location --data-file=temp_secret.txt; Remove-Item temp_secret.txt
    } else {
        Write-Info "Creating new secret mythoria-workflows-location..."
        $WorkflowsLocation.Trim() | Set-Content -Path temp_secret.txt -NoNewline; gcloud secrets create mythoria-workflows-location --data-file=temp_secret.txt --replication-policy='automatic'; Remove-Item temp_secret.txt
    }
} catch {
    Write-Info "Creating new secret mythoria-workflows-location..."
    $WorkflowsLocation.Trim() | Set-Content -Path temp_secret.txt -NoNewline; gcloud secrets create mythoria-workflows-location --data-file=temp_secret.txt --replication-policy='automatic'; Remove-Item temp_secret.txt
}

# Create optional model secrets if they exist
if ($ImageGenerationModel) {
    Write-Host "Creating image generation model secret..." -ForegroundColor Blue
    try {
        $secretExists = gcloud secrets describe mythoria-image-generation-model --format="value(name)" 2>$null
        if ($LASTEXITCODE -eq 0 -and $secretExists) {
            Write-Info "Secret mythoria-image-generation-model already exists, updating..."
            $ImageGenerationModel.Trim() | Set-Content -Path temp_secret.txt -NoNewline; gcloud secrets versions add mythoria-image-generation-model --data-file=temp_secret.txt; Remove-Item temp_secret.txt
        } else {
            Write-Info "Creating new secret mythoria-image-generation-model..."
            $ImageGenerationModel.Trim() | Set-Content -Path temp_secret.txt -NoNewline; gcloud secrets create mythoria-image-generation-model --data-file=temp_secret.txt --replication-policy='automatic'; Remove-Item temp_secret.txt
        }
    } catch {
        Write-Info "Creating new secret mythoria-image-generation-model..."
        $ImageGenerationModel.Trim() | Set-Content -Path temp_secret.txt -NoNewline; gcloud secrets create mythoria-image-generation-model --data-file=temp_secret.txt --replication-policy='automatic'; Remove-Item temp_secret.txt
    }
}

if ($AudioGenerationModel) {
    Write-Host "Creating audio generation model secret..." -ForegroundColor Blue
    try {
        $secretExists = gcloud secrets describe mythoria-audio-generation-model --format="value(name)" 2>$null
        if ($LASTEXITCODE -eq 0 -and $secretExists) {
            Write-Info "Secret mythoria-audio-generation-model already exists, updating..."
            $AudioGenerationModel.Trim() | Set-Content -Path temp_secret.txt -NoNewline; gcloud secrets versions add mythoria-audio-generation-model --data-file=temp_secret.txt; Remove-Item temp_secret.txt
        } else {
            Write-Info "Creating new secret mythoria-audio-generation-model..."
            $AudioGenerationModel.Trim() | Set-Content -Path temp_secret.txt -NoNewline; gcloud secrets create mythoria-audio-generation-model --data-file=temp_secret.txt --replication-policy='automatic'; Remove-Item temp_secret.txt
        }
    } catch {
        Write-Info "Creating new secret mythoria-audio-generation-model..."
        $AudioGenerationModel.Trim() | Set-Content -Path temp_secret.txt -NoNewline; gcloud secrets create mythoria-audio-generation-model --data-file=temp_secret.txt --replication-policy='automatic'; Remove-Item temp_secret.txt
    }
}

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
