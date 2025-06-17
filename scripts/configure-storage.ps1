# Google Cloud Storage Configuration Script for Mythoria (PowerShell)
# This script helps configure your storage bucket for public access with uniform bucket-level access

# Configuration - Update these variables
$BUCKET_NAME = "mythoria-generated-stories"
$PROJECT_ID = "your-project-id"  # Replace with your actual project ID

Write-Host "=== Mythoria Storage Configuration ===" -ForegroundColor Blue
Write-Host "This script will configure your Google Cloud Storage bucket for public access"
Write-Host "Bucket: $BUCKET_NAME"
Write-Host "Project: $PROJECT_ID"
Write-Host ""

# Check if gcloud is installed
try {
    $null = Get-Command gcloud -ErrorAction Stop
    Write-Host "[OK] Google Cloud CLI found" -ForegroundColor Green
} catch {
    Write-Host "[ERR]: gcloud CLI is not installed" -ForegroundColor Red
    Write-Host "Please install the Google Cloud CLI: https://cloud.google.com/sdk/docs/install"
    exit 1
}

# Check if user is authenticated
$activeAccount = gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>$null
if (-not $activeAccount) {
    Write-Host "- You need to authenticate with Google Cloud" -ForegroundColor Yellow
    Write-Host "Run: gcloud auth login"
    exit 1
}

Write-Host "Step 1: Checking bucket existence" -ForegroundColor Blue
gsutil ls -b "gs://$BUCKET_NAME" 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "[OK] Bucket exists" -ForegroundColor Green
} else {
    Write-Host "[ERR] Bucket does not exist" -ForegroundColor Red
    Write-Host "Creating bucket..."
    gsutil mb -p $PROJECT_ID "gs://$BUCKET_NAME"
    if ($LASTEXITCODE -eq 0) {
        Write-Host "[OK] Bucket created successfully" -ForegroundColor Green
    } else {
        Write-Host "[ERR] Failed to create bucket" -ForegroundColor Red
        exit 1
    }
}

Write-Host "Step 2: Enabling uniform bucket-level access" -ForegroundColor Blue
gsutil uniformbucketlevelaccess set on "gs://$BUCKET_NAME"
if ($LASTEXITCODE -eq 0) {
    Write-Host "[OK] Uniform bucket-level access enabled" -ForegroundColor Green
} else {
    Write-Host "[ERR] Failed to enable uniform bucket-level access" -ForegroundColor Red
    exit 1
}

Write-Host "Step 3: Configuring public read access" -ForegroundColor Blue
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET_NAME" --member=allUsers --role=roles/storage.objectViewer
if ($LASTEXITCODE -eq 0) {
    Write-Host "[OK] Public read access configured" -ForegroundColor Green
} else {
    Write-Host "[ERR] Failed to configure public access" -ForegroundColor Red
    exit 1
}

Write-Host "Step 4: Verifying configuration" -ForegroundColor Blue
Write-Host "Bucket information:"
gsutil ls -L -b "gs://$BUCKET_NAME" | Select-String -Pattern "(Uniform bucket-level access|Public access prevention)"

Write-Host ""
Write-Host "=== Configuration Complete ===" -ForegroundColor Green
Write-Host "Your bucket is now configured for:"
Write-Host "• Uniform bucket-level access (secure)"
Write-Host "• Public read access for uploaded files"
Write-Host "• Compatible with your application's upload method"
Write-Host ""
Write-Host "You can now test the configuration by calling:"
Write-Host "GET http://your-app-url/internal/storage/test"
Write-Host "GET http://your-app-url/internal/storage/info"
