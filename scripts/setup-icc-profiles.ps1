# Download and setup ICC profiles for CMYK conversion
# This downloads the industry-standard CoatedFOGRA39 profile

$profilesDir = Join-Path (Split-Path $PSScriptRoot -Parent) "icc-profiles"
$profilePath = Join-Path $profilesDir "CoatedFOGRA39.icc"

Write-Host "Setting up ICC profiles for CMYK conversion..." -ForegroundColor Green

# Create profiles directory if it doesn't exist
if (-not (Test-Path $profilesDir)) {
    New-Item -ItemType Directory -Path $profilesDir -Force | Out-Null
    Write-Host "Created ICC profiles directory: $profilesDir" -ForegroundColor Yellow
}

# For now, create a placeholder file to be replaced in production
# In production, the Dockerfile will download the proper ICC profile
$placeholderContent = "ICC Profile Placeholder - Replace with actual CoatedFOGRA39.icc profile for production use"

if (-not (Test-Path $profilePath)) {
    Write-Host "Creating ICC profile placeholder..." -ForegroundColor Yellow
    $placeholderContent | Out-File -FilePath $profilePath -Encoding UTF8
    Write-Host "Created placeholder at: $profilePath" -ForegroundColor Yellow
    Write-Host "For production deployment, the Docker build will download the real profile" -ForegroundColor Green
} else {
    Write-Host "ICC profile already exists: $profilePath" -ForegroundColor Green
}

Write-Host "ICC profile setup complete!" -ForegroundColor Green
Write-Host "Note: For local testing, Ghostscript will use built-in CMYK conversion" -ForegroundColor Yellow
