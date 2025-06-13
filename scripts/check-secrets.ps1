# Check Google Cloud Secrets Status
# This script checks which secrets exist and which need to be created for the story-generation-workflow

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
    # Change to project root directory
    Push-Location $PSScriptRoot\..
    
    try {
        $envFile = '.env.production'
        
        if (Test-Path $envFile) {
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
                }
            }
        }
    }
    finally {
        Pop-Location
    }
}

# Load environment variables
Import-EnvironmentVariables

# Use loaded environment variables or command-line parameters
$ProjectId = if ($ProjectId) { $ProjectId } else { $env:GOOGLE_CLOUD_PROJECT_ID }

if (-not $ProjectId) {
    Write-Err "ProjectId not found. Please provide it as a parameter or set GOOGLE_CLOUD_PROJECT_ID in .env.production"
    exit 1
}

Write-Host "=== Google Cloud Secrets Status Check ===" -ForegroundColor Cyan
Write-Host "Project: $ProjectId" -ForegroundColor Blue
Write-Host ""

# Set the Google Cloud project
gcloud config set project $ProjectId 2>$null

# Define secrets
$sharedSecrets = @{
    "mythoria-db-host" = "Database host (shared with mythoria-webapp)"
    "mythoria-db-user" = "Database user (shared with mythoria-webapp)"
    "mythoria-db-password" = "Database password (shared with mythoria-webapp)"
}

$storySecrets = @{
    "mythoria-storage-bucket" = "Google Cloud Storage bucket for story assets"
    "mythoria-vertex-ai-model" = "Vertex AI model ID for story generation"
    "mythoria-vertex-ai-location" = "Vertex AI location/region"
    "mythoria-workflows-location" = "Google Cloud Workflows location"
}

$optionalSecrets = @{
    "mythoria-image-generation-model" = "Image generation model (optional)"
    "mythoria-audio-generation-model" = "Audio generation model (optional)"
}

# Combine all secrets into one hashtable
$allSecrets = @{}
$sharedSecrets.GetEnumerator() | ForEach-Object { $allSecrets[$_.Key] = $_.Value }
$storySecrets.GetEnumerator() | ForEach-Object { $allSecrets[$_.Key] = $_.Value }
$optionalSecrets.GetEnumerator() | ForEach-Object { $allSecrets[$_.Key] = $_.Value }

$existingSecrets = @()
$missingSecrets = @()

Write-Host "Checking secrets..." -ForegroundColor Yellow
Write-Host ""

foreach ($secretName in $allSecrets.Keys) {
    $description = $allSecrets[$secretName]
    
    # Check if secret exists
    $exists = $null
    $secretExists = $false
    
    try {
        $exists = gcloud secrets describe $secretName --format="value(name)" 2>$null
        if ($LASTEXITCODE -eq 0 -and $exists) {
            $secretExists = $true
        }
    } catch {
        $secretExists = $false
    }
    
    if ($secretExists) {
        Write-Host "[OK] $secretName" -ForegroundColor Green
        Write-Host "     $description" -ForegroundColor Gray
        $existingSecrets += $secretName
    } else {
        Write-Host "[MISSING] $secretName" -ForegroundColor Red
        Write-Host "          $description" -ForegroundColor Gray
        $missingSecrets += $secretName
    }
    
    Write-Host ""
}

# Summary
Write-Host "=== Summary ===" -ForegroundColor Cyan
Write-Host "Total secrets checked: $($allSecrets.Count)" -ForegroundColor Blue
Write-Host "Existing secrets: $($existingSecrets.Count)" -ForegroundColor Green
Write-Host "Missing secrets: $($missingSecrets.Count)" -ForegroundColor Red

if ($missingSecrets.Count -gt 0) {
    Write-Host ""
    Write-Host "Missing secrets:" -ForegroundColor Red
    foreach ($secret in $missingSecrets) {
        Write-Host "  - $secret" -ForegroundColor Red
    }
    
    Write-Host ""
    Write-Host "To create missing secrets:" -ForegroundColor Yellow
    
    $sharedMissing = $missingSecrets | Where-Object { $sharedSecrets.ContainsKey($_) }
    $storyMissing = $missingSecrets | Where-Object { $storySecrets.ContainsKey($_) -or $optionalSecrets.ContainsKey($_) }
    
    if ($sharedMissing.Count -gt 0) {
        Write-Host "1. First, create shared secrets by running the mythoria-webapp setup:" -ForegroundColor Cyan
        Write-Host "   cd ../mythoria-webapp" -ForegroundColor White
        Write-Host "   .\scripts\setup-secrets.ps1" -ForegroundColor White
        Write-Host ""
    }
    
    if ($storyMissing.Count -gt 0) {
        Write-Host "2. Then, create story-specific secrets:" -ForegroundColor Cyan
        Write-Host "   .\scripts\setup-secrets.ps1" -ForegroundColor White
        Write-Host ""
    }
} else {
    Write-Host ""
    Write-Host "[SUCCESS] All required secrets are configured!" -ForegroundColor Green
    Write-Host ""
    Write-Host "You can now deploy the story-generation-workflow:" -ForegroundColor Cyan
    Write-Host "  npm run gcp:deploy" -ForegroundColor White
}
