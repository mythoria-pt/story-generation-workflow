<#
PowerShell deployment script for Story Generation Workflow to Google Cloud Run
Usage: .\deploy.ps1 [-Staging] [-Fast] [-Help]

Modes:
 - Normal (default): installs deps, lint, typecheck, tests, build, then deploy via Cloud Build
 - Fast: skips local quality gates, then builds and deploys the current clean commit via Cloud Build
#>

[CmdletBinding()]
param(
    [switch]$Staging,
    [switch]$Fast,
    [switch]$SkipLint,
    [switch]$Help
)

# Treat non-terminating errors as terminating so that try/catch works
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# ---- Configuration ----------------------------------------------------------
$PROJECT_ID = 'oceanic-beach-460916-n5'
$BASE_SERVICE_NAME = 'story-generation-workflow'
$SERVICE_NAME = if ($Staging) { "$BASE_SERVICE_NAME-staging" } else { $BASE_SERVICE_NAME }
$REGION = 'europe-west9'
$IMAGE_NAME = "gcr.io/$PROJECT_ID/$SERVICE_NAME"
$REPO_ROOT = Split-Path -Path $PSScriptRoot -Parent
# -----------------------------------------------------------------------------

function Show-Help {
    Write-Host "Usage: .\deploy.ps1 [-Staging] [-Fast] [-SkipLint] [-Help]" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Options:" -ForegroundColor Yellow
    Write-Host "  -Staging     Deploy to the staging service ($BASE_SERVICE_NAME-staging)" -ForegroundColor White
    Write-Host "  -Fast        Skip local quality gates, then build and deploy the clean commit" -ForegroundColor White
    Write-Host "  -SkipLint    Skip ESLint during full build (use if lint already ran in CI)" -ForegroundColor White
    Write-Host "  -Help        Show this help message" -ForegroundColor White
    Write-Host ""
    Write-Host "Note: This script now uses Google Secret Manager for sensitive data." -ForegroundColor Cyan
    Write-Host "Run .\scripts\setup-secrets.ps1 first if you haven't set up secrets yet." -ForegroundColor Cyan
}

# --- Console helpers ---------------------------------------------------------
function Write-Info { param([string]$Msg) Write-Host "[INFO] $Msg" -ForegroundColor Blue }
function Write-Success { param([string]$Msg) Write-Host "[SUCCESS] $Msg" -ForegroundColor Green }
function Write-Warn { param([string]$Msg) Write-Host "[WARN] $Msg" -ForegroundColor Yellow }
function Write-Err { param([string]$Msg) Write-Host "[ERROR] $Msg" -ForegroundColor Red }
# -----------------------------------------------------------------------------

# --- Policy Guards -----------------------------------------------------------
function Assert-NoWorkflowDeploymentStepInCloudBuild {
    try {
        $cloudBuildPath = Join-Path -Path (Join-Path $PSScriptRoot '..') 'cloudbuild.yaml'
        if (-not (Test-Path $cloudBuildPath)) {
            throw "cloudbuild.yaml not found at expected path: $cloudBuildPath"
        }
        $cb = Get-Content -Raw -Path $cloudBuildPath
        if ($cb -match '(?i)workflows\s+deploy') {
            Write-Err "Forbidden workflow deployment directive detected in cloudbuild.yaml. Remove it before deploying."
            throw "Disallowed workflow deployment step present"
        }
        else {
            Write-Info "Verified cloudbuild.yaml contains no workflow deployment step."
        }
    }
    catch {
        throw
    }
}
# -----------------------------------------------------------------------------

function Get-DeploymentGitSha {
    $status = & git -C $REPO_ROOT status --porcelain --untracked-files=normal
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to inspect Git worktree status."
    }
    if ($status) {
        throw "Deployment requires a clean Git worktree. Commit or remove all changes first."
    }

    $gitSha = (& git -C $REPO_ROOT rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $gitSha -notmatch '^[0-9a-f]{40}$') {
        throw "Unable to determine a valid Git commit SHA."
    }
    return $gitSha
}

function Test-Prerequisites {
    Write-Info "Checking prerequisites..."

    try {
        & gcloud --version  | Out-Null
        Write-Success "Google Cloud CLI is available"
    }
    catch {
        Write-Err "Google Cloud CLI is not installed or not on PATH."
        throw
    }

    try {
        $account = (& gcloud auth list --filter=status:ACTIVE --format="value(account)") | Select-Object -First 1
        if (-not $account) {
            Write-Err "Not authenticated with Google Cloud — run 'gcloud auth login' first."
            throw "Unauthenticated"
        }
        Write-Success "Authenticated as $account"
    }
    catch {
        throw
    }

    & gcloud config set project $PROJECT_ID | Out-Null
    Write-Success "Using project $PROJECT_ID"
}

function Build-Application {
    param(
        [switch]$SkipLint
    )
    Write-Info "Installing dependencies (npm ci)"
    & npm ci
    Write-Info "Checking formatting (npm run format)"
    & npm run format
    if (-not $SkipLint) {
        Write-Info "Linting (npm run lint)"
        # Ensure dev dependencies (eslint) available even if caller exported NODE_ENV=production
        $originalNodeEnv = $env:NODE_ENV
        $env:NODE_ENV = 'development'
        try {
            & npm run lint
        }
        finally {
            if ($null -ne $originalNodeEnv) { $env:NODE_ENV = $originalNodeEnv } else { Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue }
        }
    }
    else {
        Write-Warn "Skipping lint (SkipLint flag provided)"
    }
    Write-Info "Typecheck (npm run typecheck)"
    & npm run typecheck
    Write-Info "Building production bundle (npm run build)"
    & npm run build
    Write-Info "Running tests serially (npm test -- --runInBand)"
    & npm test -- --runInBand
    Write-Info "Checking environment parity (npm run env:parity)"
    & npm run env:parity
    Write-Info "Checking whitespace errors (git diff --check)"
    & git -C $REPO_ROOT diff --check
    Write-Success "Build completed"
}

function Deploy-With-CloudBuild {
    param(
        [Parameter(Mandatory = $true)]
        [string]$GitSha
    )

    $revisionSuffix = "git-$($GitSha.Substring(0, 12))"
    $cloudBuildPath = Join-Path $REPO_ROOT 'cloudbuild.yaml'
    Write-Info "Starting Cloud Build submission (beta)"
    Write-Info "Deploying immutable source commit $GitSha"
    & gcloud beta builds submit $REPO_ROOT `
        --config $cloudBuildPath `
        --project $PROJECT_ID `
        --substitutions "_SERVICE_NAME=$SERVICE_NAME,_REGION=$REGION,_GIT_SHA=$GitSha,_REVISION_SUFFIX=$revisionSuffix"
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Cloud Build submission failed"
        throw "Cloud Build failed"
    }
    Write-Success "Cloud Build finished"
}

function Deploy-Fast {
    param(
        [Parameter(Mandatory = $true)]
        [string]$GitSha
    )

    Write-Info "Fast deploy: skipping local lint/typecheck/tests, submitting to Cloud Build"
    Write-Info "Cloud Build will build and deploy commit $GitSha"
    Deploy-With-CloudBuild -GitSha $GitSha
}

function Test-Deployment {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ExpectedGitSha
    )

    Write-Info "Fetching service URL"
    $serviceJson = & gcloud run services describe $SERVICE_NAME `
        --region $REGION `
        --project $PROJECT_ID `
        --format json | ConvertFrom-Json
    $serviceUrl = $serviceJson.status.url

    if ($serviceUrl) {
        $revisionName = $serviceJson.status.latestReadyRevisionName
        $revisionJson = & gcloud run revisions describe $revisionName `
            --region $REGION `
            --project $PROJECT_ID `
            --format json | ConvertFrom-Json
        $revisionEnvironment = $revisionJson.spec.containers[0].env
        $deployedGitSha = ($revisionEnvironment | Where-Object name -eq 'DEPLOY_GIT_SHA').value
        $deployedBuildId = ($revisionEnvironment | Where-Object name -eq 'DEPLOY_BUILD_ID').value
        $traffic = $serviceJson.status.traffic | Where-Object revisionName -eq $revisionName

        if ($deployedGitSha -ne $ExpectedGitSha) {
            throw "Deployed Git SHA '$deployedGitSha' does not match expected SHA '$ExpectedGitSha'."
        }
        if ($deployedBuildId -notmatch '^[0-9a-f-]{36}$') {
            throw "Cloud Run revision does not contain a valid DEPLOY_BUILD_ID."
        }
        if (-not $traffic -or $traffic.percent -ne 100) {
            throw "Latest ready revision '$revisionName' does not have 100% traffic."
        }

        Write-Success "Deployment successful"
        Write-Success "Revision $revisionName serves 100% traffic for commit $deployedGitSha"
        Write-Host ""
        Write-Host "Service URL: $serviceUrl" -ForegroundColor Cyan
        Write-Host "Console: https://console.cloud.google.com/run/detail/$REGION/$SERVICE_NAME" -ForegroundColor Cyan
        Write-Host ""
    }
    else {
        Write-Err "Unable to determine service URL"
        throw "Describe failed"
    }
}

function Main {
    if ($Help) { Show-Help; return }

    Write-Host "Deploying Story Generation Workflow ($SERVICE_NAME)..." -ForegroundColor Magenta
    Write-Host ""

    # Enforce policy: no workflow deployment as part of this script
    Assert-NoWorkflowDeploymentStepInCloudBuild

    Test-Prerequisites
    $gitSha = Get-DeploymentGitSha
    if ($Fast) {
        Write-Info "Fast mode: skipping local build, lint, typecheck, and tests"
        Deploy-Fast -GitSha $gitSha
    }
    else {
        Build-Application -SkipLint:$SkipLint
        $verifiedGitSha = Get-DeploymentGitSha
        if ($verifiedGitSha -ne $gitSha) {
            throw "Git commit changed while quality gates were running."
        }
        Deploy-With-CloudBuild -GitSha $gitSha
    }

    Test-Deployment -ExpectedGitSha $gitSha
    Write-Success "All done"
}

try {
    Main
}
catch {
    Write-Err "Deployment failed:`n$($_.Exception.Message)"
    exit 1
}
