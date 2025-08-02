# Test CMYK conversion functionality
param(
    [Parameter(Mandatory=$false)]
    [string]$ServiceUrl = "",
    [switch]$LocalTest
)

$ErrorActionPreference = "Stop"

Write-Host "=== CMYK Conversion Test ===" -ForegroundColor Cyan

if ($LocalTest) {
    Write-Host "Testing local Ghostscript installation..." -ForegroundColor Yellow
    
    # Test Ghostscript availability
    try {
        $gsVersion = & gswin64c.exe --version 2>&1
        Write-Host "✅ Ghostscript found: $gsVersion" -ForegroundColor Green
    }
    catch {
        Write-Host "❌ Ghostscript not found or not in PATH" -ForegroundColor Red
        Write-Host "Please install Ghostscript and add it to your PATH" -ForegroundColor Yellow
        exit 1
    }
    
    # Test ICC profile
    $iccPath = Join-Path $PSScriptRoot "..\icc-profiles\ISOcoated_v2_eci.icc"
    if (Test-Path $iccPath) {
        $iccSize = (Get-Item $iccPath).Length
        if ($iccSize -gt 100KB) {
            Write-Host "✅ ICC profile found and valid ($([math]::Round($iccSize/1KB, 1))KB)" -ForegroundColor Green
        } else {
            Write-Host "⚠️  ICC profile found but seems too small (placeholder)" -ForegroundColor Yellow
        }
    } else {
        Write-Host "⚠️  ICC profile not found - will use built-in CMYK conversion" -ForegroundColor Yellow
    }
    
    # Test Node.js dependencies
    Write-Host "Testing Node.js dependencies..." -ForegroundColor Yellow
    try {
        $packageJson = Get-Content (Join-Path $PSScriptRoot "..\package.json") | ConvertFrom-Json
        if ($packageJson.dependencies.tmp) {
            Write-Host "✅ tmp package found" -ForegroundColor Green
        } else {
            Write-Host "❌ tmp package missing" -ForegroundColor Red
        }
    }
    catch {
        Write-Host "❌ Could not read package.json" -ForegroundColor Red
    }
    
    Write-Host "`n✅ Local environment test completed" -ForegroundColor Green
    exit 0
}

# Service URL test
if (-not $ServiceUrl) {
    $projectId = gcloud config get-value project 2>$null
    if ($projectId) {
        $ServiceUrl = "https://story-generation-workflow-803421888801.europe-west9.run.app"
        Write-Host "Using default service URL: $ServiceUrl" -ForegroundColor Yellow
    } else {
        Write-Host "Please provide service URL with -ServiceUrl parameter" -ForegroundColor Red
        exit 1
    }
}

Write-Host "Testing CMYK endpoint: $ServiceUrl" -ForegroundColor Yellow

# Test basic connectivity
try {
    Invoke-RestMethod -Uri "$ServiceUrl/ping" -Method GET -TimeoutSec 10 | Out-Null
    Write-Host "✅ Service is accessible" -ForegroundColor Green
}
catch {
    Write-Host "❌ Service not accessible: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# Create test request
$testRequest = @{
    storyId = "test-cmyk-story-id"
    workflowId = "test-cmyk-workflow-id"
    generateCMYK = $true
} | ConvertTo-Json

Write-Host "`nTest request payload:" -ForegroundColor Yellow
Write-Host $testRequest -ForegroundColor Gray

Write-Host "`n⚠️  Note: This will attempt to generate PDFs for a test story" -ForegroundColor Yellow
Write-Host "The request may fail if the test story doesn't exist in the database" -ForegroundColor Yellow

$userConfirm = Read-Host "Continue with API test? (y/N)"
if ($userConfirm -ne "y" -and $userConfirm -ne "Y") {
    Write-Host "Test cancelled by user" -ForegroundColor Yellow
    exit 0
}

# Test CMYK endpoint
try {
    Write-Host "`nSending CMYK generation request..." -ForegroundColor Yellow
    
    $response = Invoke-RestMethod -Uri "$ServiceUrl/internal/print/generate" -Method POST -Body $testRequest -ContentType "application/json" -TimeoutSec 300
    
    Write-Host "✅ Request successful!" -ForegroundColor Green
    Write-Host "Response:" -ForegroundColor Yellow
    $response | ConvertTo-Json -Depth 3 | Write-Host -ForegroundColor Gray
    
    if ($response.interiorCmykPdfUrl) {
        Write-Host "✅ CMYK interior PDF generated: $($response.interiorCmykPdfUrl)" -ForegroundColor Green
    }
    
    if ($response.coverCmykPdfUrl) {
        Write-Host "✅ CMYK cover PDF generated: $($response.coverCmykPdfUrl)" -ForegroundColor Green
    }
    
}
catch {
    $errorResponse = $_.ErrorDetails.Message
    Write-Host "❌ Request failed: $($_.Exception.Message)" -ForegroundColor Red
    if ($errorResponse) {
        Write-Host "Error details: $errorResponse" -ForegroundColor Red
    }
    
    if ($_.Exception.Message -like "*timeout*") {
        Write-Host "💡 Tip: CMYK conversion can take 30-60 seconds per PDF" -ForegroundColor Yellow
    }
}

Write-Host "`n🎯 CMYK Test Summary:" -ForegroundColor Cyan
Write-Host "  • Service accessibility: ✅" -ForegroundColor White
Write-Host "  • CMYK endpoint: $(if ($response) { '✅' } else { '❌' })" -ForegroundColor White
Write-Host "  • PDF generation: $(if ($response.interiorPdfUrl) { '✅' } else { '❌' })" -ForegroundColor White
Write-Host "  • CMYK conversion: $(if ($response.interiorCmykPdfUrl) { '✅' } else { '❌' })" -ForegroundColor White
