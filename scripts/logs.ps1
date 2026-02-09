Param(
    [string]$ProjectId = "oceanic-beach-460916-n5",
    [string]$Region = "europe-west9",
    [string]$ServiceName = "story-generation-workflow",
    [int]$Limit = 300,
    [switch]$Follow,
    [string]$OutFile
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Path $PSScriptRoot -Parent
$logsDir = Join-Path $repoRoot "logs"
$logFilter = "resource.type=`"cloud_run_revision`" AND resource.labels.service_name=`"$ServiceName`" AND resource.labels.location=`"$Region`""
if (-not (Test-Path -Path $logsDir)) {
    New-Item -ItemType Directory -Path $logsDir | Out-Null
}

if (-not $Follow) {
    if ([string]::IsNullOrWhiteSpace($OutFile)) {
        $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $OutFile = Join-Path $logsDir ("cloudrun-" + $ServiceName + "-" + $timestamp + ".json")
    }
}

Write-Host "Reading logs for Cloud Run service '$ServiceName' in region '$Region' (project '$ProjectId')."

$logCommand = "read"
if ($Follow) {
    $logCommand = "tail"
}

function Write-ErrorLogFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SourceFile
    )

    if (-not (Test-Path -Path $SourceFile)) {
        return
    }

    $dir = Split-Path -Parent $SourceFile
    $base = [System.IO.Path]::GetFileNameWithoutExtension($SourceFile)
    $ext = [System.IO.Path]::GetExtension($SourceFile)
    if ([string]::IsNullOrWhiteSpace($ext)) {
        $ext = ".json"
    }
    $errorsFile = Join-Path $dir ($base + "_errors" + $ext)

    # Keep lines that look like error entries. This matches JSON severity or plain text logs.
    Get-Content -Path $SourceFile | Select-String -Pattern '"severity"\s*:\s*"ERROR"|\berror\b' -CaseSensitive:$false | ForEach-Object { $_.Line } | Set-Content -Path $errorsFile
    Write-Host "Saved error-only logs to: $errorsFile"
}

$baseArgs = @(
    "run", "services", "logs",
    $logCommand,
    $ServiceName,
    "--region", $Region,
    "--project", $ProjectId
)

$commandSucceeded = $true
$primaryErrorMessage = $null

try {
    if ($Follow) {
        Write-Host "Streaming logs (press Ctrl+C to stop)..."
        gcloud @baseArgs
        if ($LASTEXITCODE -ne 0) {
            $commandSucceeded = $false
        }
    }
    else {
        $readArgs = $baseArgs + @("--limit", $Limit, "--format", "json")
        gcloud @readArgs 2>&1 | Tee-Object -FilePath $OutFile | Out-Null
        if ($LASTEXITCODE -ne 0) {
            $commandSucceeded = $false
        }
        else {
            Write-Host "Saved logs to: $OutFile"
            Write-ErrorLogFile -SourceFile $OutFile
        }
    }
}
catch {
    $commandSucceeded = $false
    $primaryErrorMessage = $_.Exception.Message
}

if (-not $commandSucceeded) {
    if ($primaryErrorMessage) {
        Write-Warning "Cloud Run logs command failed: $primaryErrorMessage"
    }
    else {
        Write-Warning "Cloud Run logs command failed with exit code $LASTEXITCODE"
    }

    try {
        if ($Follow) {
            $fallbackArgs = @(
                "logging", "tail", $logFilter,
                "--project", $ProjectId,
                "--format", "json"
            )
            gcloud @fallbackArgs
        }
        else {
            $fallbackArgs = @(
                "logging", "read", $logFilter,
                "--project", $ProjectId,
                "--limit", $Limit,
                "--format", "json"
            )
            gcloud @fallbackArgs 2>&1 | Tee-Object -FilePath $OutFile | Out-Null
            Write-Host "Saved logs to: $OutFile (Cloud Logging fallback)"
            Write-ErrorLogFile -SourceFile $OutFile
        }
        if ($LASTEXITCODE -ne 0) {
            throw "Cloud Logging fallback command failed."
        }
    }
    catch {
        Write-Error "Failed to retrieve Cloud Run logs. Ensure gcloud is installed, authenticated, and you have access. Error: $($_.Exception.Message)"
        exit 1
    }
}
