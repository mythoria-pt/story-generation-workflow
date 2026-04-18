# Sync Mythoria DB Schema Script
# Syncs only the required schema files from mythoria-webapp to story-generation-workflow

param(
    [switch]$DryRun = $false,
    [switch]$Verbose = $false
)

# Define paths
$SourcePath = "C:\Mythoria\mythoria-webapp\src\db\schema"
$TargetPath = "C:\Mythoria\story-generation-workflow\src\db\schema"

# Define which schema files are needed by story-generation-workflow
$RequiredSchemas = @(
    "enums.ts",
    "authors.ts", 
    "stories.ts",
    "characters.ts",
    "credits.ts",
    "pricing.ts",
    "shipping.ts",
    "payments.ts",
    "print.ts",
    "ratings.ts",
    "relations.ts"
)

Write-Host "Mythoria Schema Sync Tool" -ForegroundColor Cyan
Write-Host "========================" -ForegroundColor Cyan
Write-Host ""

if ($DryRun) {
    Write-Host "DRY RUN MODE - No files will be modified" -ForegroundColor Yellow
    Write-Host ""
}

# Ensure target directory exists
if (-not (Test-Path $TargetPath)) {
    Write-Host "Creating target directory: $TargetPath" -ForegroundColor Green
    if (-not $DryRun) {
        New-Item -ItemType Directory -Path $TargetPath -Force | Out-Null
    }
}

$SyncCount = 0
$ErrorCount = 0

foreach ($Schema in $RequiredSchemas) {
    $SourceFile = Join-Path $SourcePath $Schema
    $TargetFile = Join-Path $TargetPath $Schema
    
    Write-Host "Processing: $Schema" -ForegroundColor White
    
    # Check if source file exists
    if (-not (Test-Path $SourceFile)) {
        Write-Host "  ERROR: Source file not found: $SourceFile" -ForegroundColor Red
        $ErrorCount++
        continue
    }
    
    # Check if target file exists and compare
    $ShouldSync = $true
    if (Test-Path $TargetFile) {
        # Compare file sizes and last write time instead of hash for compatibility
        $SourceInfo = Get-Item $SourceFile
        $TargetInfo = Get-Item $TargetFile
        
        if ($SourceInfo.Length -eq $TargetInfo.Length -and 
            $SourceInfo.LastWriteTime -eq $TargetInfo.LastWriteTime) {
            Write-Host "  SKIP: Files appear identical (same size and timestamp)" -ForegroundColor Gray
            $ShouldSync = $false
        } else {
            Write-Host "  UPDATE: Files differ (size: $($SourceInfo.Length) vs $($TargetInfo.Length), time: $($SourceInfo.LastWriteTime) vs $($TargetInfo.LastWriteTime))" -ForegroundColor Yellow
        }
    } else {
        Write-Host "  NEW: Target file does not exist" -ForegroundColor Green
    }
    
    if ($ShouldSync) {
        if (-not $DryRun) {
            try {
                Copy-Item $SourceFile $TargetFile -Force
                Write-Host "  SUCCESS: Synced successfully" -ForegroundColor Green
                $SyncCount++
            } catch {
                Write-Host "  ERROR: Failed to sync - $($_.Exception.Message)" -ForegroundColor Red
                $ErrorCount++
            }
        } else {
            Write-Host "  WOULD SYNC: $SourceFile -> $TargetFile" -ForegroundColor Cyan
            $SyncCount++
        }
    }
    
    if ($Verbose -and (Test-Path $SourceFile)) {
        $SourceSize = (Get-Item $SourceFile).Length
        Write-Host "    Source size: $SourceSize bytes" -ForegroundColor Gray
    }
}

# Update index.ts if any files were synced
if ($SyncCount -gt 0 -and -not $DryRun) {
    $IndexPath = Join-Path $TargetPath "index.ts"
    $IndexContent = @"
// -----------------------------------------------------------------------------
// Shared database schema - imports from mythoria-webapp
// This allows both applications to share the same database schema
// 
// Note: These are individual imports to avoid TypeScript compilation issues
// with cross-project references. Each schema is imported from the webapp.
// 
// Last synced: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
// -----------------------------------------------------------------------------

// Re-export schemas from mythoria-webapp (synced automatically)

export * from './enums.js';
export * from './authors.js';
export * from './stories.js';
export * from './characters.js';
export * from './credits.js';
export * from './pricing.js';
export * from './token-usage.js';
export * from './relations.js';

"@
    
    Set-Content -Path $IndexPath -Value $IndexContent -Encoding UTF8
    Write-Host ""
    Write-Host "Updated index.ts with sync timestamp" -ForegroundColor Green
}

# Summary
Write-Host ""
Write-Host "Sync Summary:" -ForegroundColor Cyan
Write-Host "=============" -ForegroundColor Cyan
Write-Host "Files synced: $SyncCount" -ForegroundColor $(if ($SyncCount -gt 0) { "Green" } else { "Gray" })
Write-Host "Errors: $ErrorCount" -ForegroundColor $(if ($ErrorCount -gt 0) { "Red" } else { "Gray" })

if ($DryRun) {
    Write-Host ""
    Write-Host "To apply changes, run without -DryRun flag" -ForegroundColor Yellow
}

if ($ErrorCount -gt 0) {
    exit 1
}
