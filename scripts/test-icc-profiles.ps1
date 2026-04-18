# Test ICC Profile Loading and Validation
# This script tests if the ICC profiles are properly configured and accessible

Write-Host "Testing ICC Profile Configuration..." -ForegroundColor Green

$projectRoot = Get-Location
$iccProfilesPath = Join-Path $projectRoot "icc-profiles"
$configPath = Join-Path $projectRoot "src\config\icc-profiles.json"

Write-Host "Project Root: $projectRoot" -ForegroundColor Yellow
Write-Host "ICC Profiles Path: $iccProfilesPath" -ForegroundColor Yellow
Write-Host "Config Path: $configPath" -ForegroundColor Yellow

# Check if ICC profiles directory exists
if (Test-Path $iccProfilesPath) {
    Write-Host "✅ ICC profiles directory exists" -ForegroundColor Green
    
    # List all ICC files
    $iccFiles = Get-ChildItem -Path $iccProfilesPath -Filter "*.icc"
    Write-Host "Found ICC profiles:" -ForegroundColor Cyan
    foreach ($file in $iccFiles) {
        $sizeKB = [math]::Round($file.Length / 1024, 1)
        Write-Host "  - $($file.Name) ($sizeKB KB)" -ForegroundColor White
        
        # Validate file size (should be > 100KB for real ICC profiles)
        if ($file.Length -gt 102400) {
            Write-Host "    ✅ File size valid (>100KB)" -ForegroundColor Green
        } else {
            Write-Host "    ⚠️  File size too small, might be a placeholder" -ForegroundColor Yellow
        }
    }
} else {
    Write-Host "❌ ICC profiles directory not found: $iccProfilesPath" -ForegroundColor Red
    exit 1
}

# Check if configuration file exists and parse it
if (Test-Path $configPath) {
    Write-Host "✅ Configuration file exists" -ForegroundColor Green
    
    try {
        $config = Get-Content $configPath -Raw | ConvertFrom-Json
        Write-Host "Configuration loaded successfully:" -ForegroundColor Cyan
        Write-Host "  Default Profile: $($config.defaultProfile)" -ForegroundColor White
        
        # Check each configured profile
        foreach ($profileKey in $config.profiles.PSObject.Properties.Name) {
            $profileConfig = $config.profiles.$profileKey
            $profilePath = Join-Path $iccProfilesPath $profileConfig.filename
            
            Write-Host "Profile: $profileKey" -ForegroundColor Cyan
            Write-Host "  Name: $($profileConfig.name)" -ForegroundColor White
            Write-Host "  Filename: $($profileConfig.filename)" -ForegroundColor White
            
            if (Test-Path $profilePath) {
                $fileInfo = Get-Item $profilePath
                $sizeKB = [math]::Round($fileInfo.Length / 1024, 1)
                Write-Host "  ✅ File exists ($sizeKB KB)" -ForegroundColor Green
            } else {
                Write-Host "  ❌ File not found: $profilePath" -ForegroundColor Red
            }
        }
        
    } catch {
        Write-Host "❌ Failed to parse configuration file: $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "❌ Configuration file not found: $configPath" -ForegroundColor Red
    exit 1
}

# Test Ghostscript installation
Write-Host "`nTesting Ghostscript installation..." -ForegroundColor Green
try {
    $gsVersion = & gswin64c.exe --version 2>&1
    Write-Host "✅ Ghostscript found: $gsVersion" -ForegroundColor Green
} catch {
    Write-Host "❌ Ghostscript not found or not in PATH" -ForegroundColor Red
    Write-Host "Make sure Ghostscript is installed and gswin64c.exe is in your PATH" -ForegroundColor Yellow
}

Write-Host "`nICC Profile test completed!" -ForegroundColor Green
