# Download real ICC profile for development testing
param(
    [switch]$Force
)

$profilesDir = Join-Path (Split-Path $PSScriptRoot -Parent) "icc-profiles"
$profilePath = Join-Path $profilesDir "CoatedFOGRA39.icc"

Write-Host "Downloading real ICC profile for development..." -ForegroundColor Green

# Create profiles directory if it does not exist
if (-not (Test-Path $profilesDir)) {
    New-Item -ItemType Directory -Path $profilesDir -Force | Out-Null
    Write-Host "Created ICC profiles directory: $profilesDir" -ForegroundColor Yellow
}

# Check if profile already exists and is valid
if ((Test-Path $profilePath) -and -not $Force) {
    $fileSize = (Get-Item $profilePath).Length
    if ($fileSize -gt 100KB) {
        $content = Get-Content $profilePath -Raw -ErrorAction SilentlyContinue
        if (-not ($content -like "*ICC Profile Placeholder*")) {
            Write-Host "Valid ICC profile already exists. Use -Force to replace." -ForegroundColor Green
            Write-Host "File size: $([math]::Round($fileSize/1KB, 1))KB" -ForegroundColor Green
            exit 0
        }
    }
}

# Try to download from a reliable source
$url = "https://github.com/saucecontrol/Compact-ICC-Profiles/raw/master/profiles/CoatedFOGRA39.icc"

try {
    Write-Host "Attempting download from GitHub..." -ForegroundColor Yellow
    
    # Use TLS 1.2 for secure connections
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    
    Invoke-WebRequest -Uri $url -OutFile $profilePath -UseBasicParsing -TimeoutSec 30
    
    # Verify download
    if (Test-Path $profilePath) {
        $fileSize = (Get-Item $profilePath).Length
        if ($fileSize -gt 100KB) {
            Write-Host "Successfully downloaded ICC profile!" -ForegroundColor Green
            Write-Host "File size: $([math]::Round($fileSize/1KB, 1))KB" -ForegroundColor Green
        } else {
            Write-Host "Downloaded file too small, removing..." -ForegroundColor Yellow
            Remove-Item $profilePath -Force
            throw "Invalid ICC profile downloaded"
        }
    }
}
catch {
    Write-Host "Failed to download ICC profile" -ForegroundColor Red
    Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
    
    Write-Host "Creating placeholder for built-in CMYK conversion..." -ForegroundColor Yellow
    "ICC Profile Placeholder - Built-in CMYK conversion will be used" | Out-File -FilePath $profilePath -Encoding UTF8
    
    Write-Host "Manual download instructions:" -ForegroundColor Yellow
    Write-Host "1. Visit https://www.eci.org/downloads" -ForegroundColor White
    Write-Host "2. Download CoatedFOGRA39.icc profile" -ForegroundColor White
    Write-Host "3. Save it to: $profilePath" -ForegroundColor White
}

Write-Host "ICC profile setup complete!" -ForegroundColor Green
Write-Host "To test the CMYK service: npm run test:cmyk" -ForegroundColor White
