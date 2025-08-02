# Test Ghostscript CMYK conversion without ICC profile
param(
    [string]$InputPDF = ""
)

Write-Host "Testing Ghostscript CMYK conversion..." -ForegroundColor Green

# Create a simple test PDF if none provided
if (-not $InputPDF -or -not (Test-Path $InputPDF)) {
    Write-Host "Creating test PDF..." -ForegroundColor Yellow
    
    $testPS = @"
%!PS-Adobe-3.0
/DeviceRGB setcolorspace
0.8 0.2 0.2 setcolor
100 100 300 200 rectfill
/Helvetica findfont 24 scalefont setfont
120 150 moveto
(CMYK Test) show
showpage
"@
    
    $tempDir = [System.IO.Path]::GetTempPath()
    $testPSFile = Join-Path $tempDir "test.ps"
    $testPDFFile = Join-Path $tempDir "test-rgb.pdf"
    
    $testPS | Out-File -FilePath $testPSFile -Encoding ASCII
    
    # Convert PS to PDF
    & gswin64c.exe -dNOPAUSE -dBATCH -dSAFER -sDEVICE=pdfwrite -sOutputFile="$testPDFFile" "$testPSFile"
    
    if (Test-Path $testPDFFile) {
        Write-Host "Test PDF created: $testPDFFile" -ForegroundColor Green
        $InputPDF = $testPDFFile
    } else {
        Write-Error "Failed to create test PDF"
        exit 1
    }
}

# Test CMYK conversion
$outputCMYK = [System.IO.Path]::ChangeExtension($InputPDF, "-cmyk.pdf")

Write-Host "Converting to CMYK: $InputPDF -> $outputCMYK" -ForegroundColor Yellow

$gsArgs = @(
    "-dNOPAUSE",
    "-dBATCH", 
    "-dSAFER",
    "-sDEVICE=pdfwrite",
    "-dCompatibilityLevel=1.4",
    "-sColorConversionStrategy=CMYK",
    "-sProcessColorModel=DeviceCMYK",
    "-dOverrideICC=true",
    "-dRenderIntent=0",
    "-dDeviceGrayToK=true",
    "-sOutputFile=`"$outputCMYK`"",
    "`"$InputPDF`""
)

$command = "gswin64c.exe " + ($gsArgs -join " ")
Write-Host "Command: $command" -ForegroundColor Gray

try {
    & gswin64c.exe @gsArgs
    
    if (Test-Path $outputCMYK) {
        $size = (Get-Item $outputCMYK).Length
        Write-Host "Success! CMYK PDF created: $outputCMYK" -ForegroundColor Green
        Write-Host "File size: $([math]::Round($size/1KB, 1))KB" -ForegroundColor Green
    } else {
        Write-Error "CMYK PDF was not created"
    }
}
catch {
    Write-Error "Ghostscript conversion failed: $($_.Exception.Message)"
}

Write-Host "Test complete!" -ForegroundColor Cyan
