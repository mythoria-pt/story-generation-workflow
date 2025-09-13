﻿<#
PowerShell deployment script for Story Generation Workflow to Google Cloud Run
Usage: .\deploy.ps1 [-Staging] [-Fast] [-Help]

Modes:
 - Normal (default): installs deps, lint, typecheck, tests, build, then deploy via Cloud Build
 - Fast: reuses the last built image (no build/lint/tests) and deploys directly to Cloud Run
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

# ---- Configuration ----------------------------------------------------------
$PROJECT_ID        = 'oceanic-beach-460916-n5'
$BASE_SERVICE_NAME = 'story-generation-workflow'
$SERVICE_NAME      = if ($Staging) { "$BASE_SERVICE_NAME-staging" } else { $BASE_SERVICE_NAME }
$REGION            = 'europe-west9'
$IMAGE_NAME        = "gcr.io/$PROJECT_ID/$SERVICE_NAME"
# -----------------------------------------------------------------------------

function Show-Help {
    Write-Host "Usage: .\deploy.ps1 [-Staging] [-Fast] [-SkipLint] [-Help]" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Options:" -ForegroundColor Yellow
    Write-Host "  -Staging     Deploy to the staging service ($BASE_SERVICE_NAME-staging)" -ForegroundColor White
    Write-Host "  -Fast        Reuse last built image (skip build/lint/tests) and deploy to Cloud Run" -ForegroundColor White
    Write-Host "  -SkipLint    Skip ESLint during full build (use if lint already ran in CI)" -ForegroundColor White
    Write-Host "  -Help        Show this help message" -ForegroundColor White
    Write-Host ""
    Write-Host "Note: This script now uses Google Secret Manager for sensitive data." -ForegroundColor Cyan
    Write-Host "Run .\scripts\setup-secrets.ps1 first if you haven't set up secrets yet." -ForegroundColor Cyan
}

# --- Console helpers ---------------------------------------------------------
function Write-Info     { param([string]$Msg) Write-Host "[INFO] $Msg" -ForegroundColor Blue }
function Write-Success  { param([string]$Msg) Write-Host "[SUCCESS] $Msg" -ForegroundColor Green }
function Write-Warn     { param([string]$Msg) Write-Host "[WARN] $Msg" -ForegroundColor Yellow }
function Write-Err      { param([string]$Msg) Write-Host "[ERROR] $Msg" -ForegroundColor Red }
# -----------------------------------------------------------------------------

function Test-Prerequisites {
    Write-Info "Checking prerequisites..."

    try {
        & gcloud --version  | Out-Null
        Write-Success "Google Cloud CLI is available"
    } catch {
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
    } catch {
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
    if (-not $SkipLint) {
        Write-Info "Linting (npm run lint)"
        # Ensure dev dependencies (eslint) available even if caller exported NODE_ENV=production
        $originalNodeEnv = $env:NODE_ENV
        $env:NODE_ENV = 'development'
        try {
            & npm run lint
        } finally {
            if ($null -ne $originalNodeEnv) { $env:NODE_ENV = $originalNodeEnv } else { Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue }
        }
    } else {
        Write-Warn "Skipping lint (SkipLint flag provided)"
    }
    Write-Info "Typecheck (npm run typecheck)"
    & npm run typecheck
    Write-Info "Running tests (npm test)"
    & npm test
    Write-Info "Building production bundle (npm run build)"
    & npm run build
    Write-Success "Build completed"
}

function Deploy-With-CloudBuild {
    Write-Info "Starting Cloud Build submission (beta)"
    # Pass service name and region as substitutions
    & gcloud beta builds submit --config cloudbuild.yaml --substitutions "_SERVICE_NAME=$SERVICE_NAME,_REGION=$REGION"
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Cloud Build submission failed"
        throw "Cloud Build failed"
    }
    Write-Success "Cloud Build finished"
}

function Deploy-Fast {
    Write-Info "Fast deploy: reusing last built image from Container Registry"
    $digest = (& gcloud container images list-tags $IMAGE_NAME --format="get(digest)" --limit=1 --sort-by=~timestamp 2>$null)
    if (-not $digest) {
        Write-Err "No prior image found for $IMAGE_NAME. Fast deploy requires an existing image."
        throw "Missing image"
    }
    $imageRef = "$IMAGE_NAME@sha256:$digest"
    Write-Info "Deploying image $imageRef to Cloud Run service $SERVICE_NAME in $REGION"
    & gcloud run deploy $SERVICE_NAME --image $imageRef --region $REGION --platform managed --quiet
    Write-Success "Fast deploy submitted"
}

function Test-Deployment {
    Write-Info "Fetching service URL"
    $serviceUrl = & gcloud run services describe $SERVICE_NAME --region $REGION --format="value(status.url)"

    if ($serviceUrl) {
        Write-Success "Deployment successful"
        Write-Host ""
        Write-Host "Service URL: $serviceUrl" -ForegroundColor Cyan
        Write-Host "Console: https://console.cloud.google.com/run/detail/$REGION/$SERVICE_NAME" -ForegroundColor Cyan
        Write-Host ""
    } else {
        Write-Err "Unable to determine service URL"
        throw "Describe failed"
    }
}

function Main {
    if ($Help) { Show-Help; return }

    Write-Host "Deploying Story Generation Workflow ($SERVICE_NAME)..." -ForegroundColor Magenta
    Write-Host ""

    Test-Prerequisites
    if ($Fast) {
        Deploy-Fast
    } else {
        Build-Application -SkipLint:$SkipLint
        Deploy-With-CloudBuild
    }

    Test-Deployment
    Write-Success "All done"
}

try {
    Main
} catch {
    Write-Err "Deployment failed:`n$($_.Exception.Message)"
    exit 1
}
