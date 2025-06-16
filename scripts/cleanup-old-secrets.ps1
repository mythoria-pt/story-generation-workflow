# Cleanup script to remove secrets that have been converted to environment variables
# Run this script to clean up the old secrets from Google Cloud Secret Manager
# These secrets are now handled as environment variables in cloudbuild.yaml

param(
    [Parameter(Mandatory=$false)]
    [string]$ProjectId
)

# Console helper functions
function Write-Info     { param([string]$Msg) Write-Host "[INFO] $Msg" -ForegroundColor Blue  }
function Write-Success  { param([string]$Msg) Write-Host "[SUCCESS] $Msg" -ForegroundColor Green }
function Write-Warn     { param([string]$Msg) Write-Host "[WARN] $Msg" -ForegroundColor Yellow }
function Write-Err      { param([string]$Msg) Write-Host "[ERROR] $Msg" -ForegroundColor Red   }

# Get project ID if not provided
if (-not $ProjectId) {
    try {
        $ProjectId = gcloud config get-value project 2>$null
        if (-not $ProjectId) {
            Write-Err "No project ID provided and no default project set. Please provide -ProjectId parameter."
            exit 1
        }
        Write-Info "Using current gcloud project: $ProjectId"
    } catch {
        Write-Err "Failed to get current gcloud project. Please provide -ProjectId parameter."
        exit 1
    }
}

# Set the Google Cloud project
Write-Info "Setting Google Cloud project to: $ProjectId"
gcloud config set project $ProjectId

# List of secrets to remove (now handled as environment variables)
$secretsToRemove = @(
    'mythoria-generated-stories-bucket',
    'mythoria-audio-generation-model', 
    'mythoria-image-generation-model',
    'mythoria-workflows-location',
    'mythoria-vertex-ai-location',
    'mythoria-vertex-ai-model',
    'mythoria-storage-bucket'
)

Write-Info "The following secrets will be removed as they are now environment variables:"
foreach ($secret in $secretsToRemove) {
    Write-Host "  - $secret" -ForegroundColor Yellow
}

Write-Host ""
Write-Warn "This action cannot be undone. Are you sure you want to proceed?"
$confirmation = Read-Host "Type 'yes' to continue, or any other key to cancel"

if ($confirmation -ne 'yes') {
    Write-Info "Operation cancelled."
    exit 0
}

Write-Info "Removing old secrets..."

foreach ($secretName in $secretsToRemove) {
    try {
        # Check if secret exists
        $secretExists = gcloud secrets describe $secretName --format="value(name)" 2>$null
        
        if ($LASTEXITCODE -eq 0 -and $secretExists) {
            Write-Info "Removing secret: $secretName"
            gcloud secrets delete $secretName --quiet
            
            if ($LASTEXITCODE -eq 0) {
                Write-Success "Successfully removed: $secretName"
            } else {
                Write-Err "Failed to remove: $secretName"
            }
        } else {
            Write-Info "Secret not found (already removed?): $secretName"
        }
    } catch {
        Write-Warn "Error checking/removing secret: $secretName - $_"
    }
}

Write-Success "Cleanup complete!"
Write-Info "Remaining secrets are now only for sensitive data (database credentials, API keys)"
Write-Info "All configuration values are now handled as environment variables in cloudbuild.yaml"
