# CMYK Conversion Debug Test Script
# This script helps debug CMYK conversion issues

Write-Host "CMYK Conversion Debug Test" -ForegroundColor Green
Write-Host "=========================="

# Check if Ghostscript is available
Write-Host "`nTesting Ghostscript installation..." -ForegroundColor Yellow
try {
    $gsVersion = & gswin64c.exe --version 2>&1
    Write-Host "[OK] Ghostscript found: $gsVersion" -ForegroundColor Green
} catch {
    Write-Host "[ERROR] Ghostscript not found. Please install Ghostscript and add to PATH" -ForegroundColor Red
    exit 1
}

# Check ICC profiles
Write-Host "`nChecking ICC profiles..." -ForegroundColor Yellow
$iccPath = "C:\Mythoria\story-generation-workflow\icc-profiles"
$profileFile = "PSO_Coated_NPscreen_ISO12647_eci.icc"
$fullProfilePath = Join-Path $iccPath $profileFile

if (Test-Path $fullProfilePath) {
    $fileSize = (Get-Item $fullProfilePath).Length
    if ($fileSize -gt (100 * 1024)) {
        Write-Host "[OK] ICC profile found and valid: $fullProfilePath ($fileSize bytes)" -ForegroundColor Green
    } else {
        Write-Host "[ERROR] ICC profile too small: $fullProfilePath ($fileSize bytes)" -ForegroundColor Red
    }
} else {
    Write-Host "[ERROR] ICC profile not found: $fullProfilePath" -ForegroundColor Red
}

# Test basic Ghostscript command structure
Write-Host "`nTesting basic Ghostscript command..." -ForegroundColor Yellow

$tempDir = [System.IO.Path]::GetTempPath()
$testOutput = Join-Path $tempDir "test-cmyk-output.pdf"

# Create a simple test PostScript file
$testPS = Join-Path $tempDir "test.ps"
$psContent = @"
%!PS-Adobe-3.0
/Times-Roman findfont 12 scalefont setfont
100 700 moveto
(This is a test) show
showpage
"@
Set-Content -Path $testPS -Value $psContent

# Test basic PDF creation
Write-Host "Testing basic PDF creation..."
$basicCmd = "gswin64c.exe -dNOPAUSE -dBATCH -dSAFER -dQUIET -sDEVICE=pdfwrite -sOutputFile=`"$testOutput`" `"$testPS`""
Write-Host "Command: $basicCmd"

try {
    Invoke-Expression $basicCmd
    if (Test-Path $testOutput) {
        Write-Host "[OK] Basic PDF creation successful" -ForegroundColor Green
        Remove-Item $testOutput -ErrorAction SilentlyContinue
    } else {
        Write-Host "[ERROR] Basic PDF creation failed - no output file" -ForegroundColor Red
    }
} catch {
    Write-Host "[ERROR] Basic PDF creation failed: $($_.Exception.Message)" -ForegroundColor Red
}

# Clean up
Remove-Item $testPS -ErrorAction SilentlyContinue

Write-Host "`nDebug test completed." -ForegroundColor Green
