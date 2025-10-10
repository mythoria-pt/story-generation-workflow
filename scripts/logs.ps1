Param(
    [string]$ProjectId = "oceanic-beach-460916-n5",
    [string]$Region = "europe-west9",
    [string]$ServiceName = "story-generation-workflow",
    [int]$Limit = 300,
    [switch]$Follow,
    [string]$OutFile
)

$ErrorActionPreference = "Stop"

# Resolve repo root and logs directory
$repoRoot = Split-Path -Path $PSScriptRoot -Parent
$logsDir = Join-Path $repoRoot "logs"
if (-not (Test-Path -Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir | Out-Null }

# Default output file if not provided and not following
if (-not $Follow) {
    if (-not $OutFile -or $OutFile.Trim() -eq "") {
        $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $OutFile = Join-Path $logsDir ("cloudrun-" + $ServiceName + "-" + $timestamp + ".json")
    }
}

Write-Host "Reading logs for Cloud Run service '$ServiceName' in region '$Region' (project '$ProjectId')."

try {
    if ($Follow) {
        # Tail logs in real-time
        gcloud logs tail "projects/$ProjectId/logs/run.googleapis.com%2Fstdout" --filter="resource.labels.service_name=$ServiceName AND resource.labels.location=$Region"
    }
    else {
        # Read latest logs in JSON and write to file
        $gcloudArgs = @(
            "run", "services", "logs", "read", $ServiceName,
            "--region", $Region,
            "--project", $ProjectId,
            "--limit", $Limit,
            "--format", "json"
        )
        gcloud @gcloudArgs 2>&1 | Tee-Object -FilePath $OutFile | Out-Null
        Write-Host "Saved logs to: $OutFile"
    }
}
catch {
    Write-Error "Failed to read logs. Ensure gcloud is installed, authenticated, and you have access. Error: $($_.Exception.Message)"
    exit 1
}
