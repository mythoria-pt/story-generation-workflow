param(
    [string]$InputPDF = ""
)

Write-Host "Testing Ghostscript CMYK conversion..." -ForegroundColor Green

function Resolve-GhostscriptBinary {
    # 1) Respect explicit env var
    if ($env:GHOSTSCRIPT_BINARY -and (Test-Path $env:GHOSTSCRIPT_BINARY)) { return $env:GHOSTSCRIPT_BINARY }
    
    # 2) Try PATH
    $names = @('gswin64c.exe','gswin32c.exe','gs.exe')
    foreach ($n in $names) {
        $p = (Get-Command $n -ErrorAction SilentlyContinue | Select-Object -First 1).Path
        if ($p) { return $p }
    }

    # 3) Search common install locations
    $roots = @()
    if ($env:ProgramFiles) { $roots += (Join-Path $env:ProgramFiles 'gs') }
    if (${env:ProgramFiles(x86)}) { $roots += (Join-Path ${env:ProgramFiles(x86)} 'gs') }

    foreach ($root in $roots) {
        if (-not (Test-Path $root)) { continue }
        $bins = Get-ChildItem -Path $root -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName 'bin' } |
            Where-Object { Test-Path $_ }

        foreach ($bin in $bins) {
            foreach ($n in $names) {
                $candidate = Join-Path $bin $n
                if (Test-Path $candidate) { return $candidate }
            }
        }
    }
    return $null
}

$gs = Resolve-GhostscriptBinary
if (-not $gs) {
    Write-Error "Ghostscript not found. Install it or set GHOSTSCRIPT_BINARY to the full path of gswin64c.exe."
    exit 1
}

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
    
    # Convert PS to PDF using resolved Ghostscript
    & $gs -dNOPAUSE -dBATCH -sDEVICE=pdfwrite -o "$testPDFFile" "$testPSFile"
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $testPDFFile)) {
        Write-Error "Failed to create test PDF (Ghostscript exit code $LASTEXITCODE)"
        exit 1
    }
    Write-Host "Test PDF created: $testPDFFile" -ForegroundColor Green
    $InputPDF = $testPDFFile
}

# Build CMYK output path properly (test-rgb.pdf -> test-rgb-cmyk.pdf)
$dir  = [System.IO.Path]::GetDirectoryName($InputPDF)
$name = [System.IO.Path]::GetFileNameWithoutExtension($InputPDF)
$ext  = [System.IO.Path]::GetExtension($InputPDF)
$outputCMYK = Join-Path $dir ("$name-cmyk$ext")

Write-Host "Converting to CMYK: $InputPDF -> $outputCMYK" -ForegroundColor Yellow


$gsArgs = @(
    "-dNOPAUSE",
    "-dBATCH", 
    "-sDEVICE=pdfwrite",
    "-dCompatibilityLevel=1.4",
    "-sColorConversionStrategy=CMYK",
    "-sProcessColorModel=DeviceCMYK",
    "-dOverrideICC=true",
    "-dRenderIntent=0",
    "-dDeviceGrayToK=true",
    "-o", "$outputCMYK",
    "$InputPDF"
)

$command = "`"$gs`" " + ($gsArgs -join " ")
Write-Host "Command: $command" -ForegroundColor Gray

try {
    & $gs @gsArgs
    
    if (Test-Path $outputCMYK) {
        $size = (Get-Item $outputCMYK).Length
        Write-Host "Success! CMYK PDF created: $outputCMYK" -ForegroundColor Green
        Write-Host "File size: $([math]::Round($size/1KB, 1))KB" -ForegroundColor Green
    } else {
        Write-Error "CMYK PDF was not created"
        exit 1
    }
}
catch {
    Write-Error "Ghostscript conversion failed: $($_.Exception.Message)"
    exit 1
}

Write-Host "Test complete!" -ForegroundColor Cyan
