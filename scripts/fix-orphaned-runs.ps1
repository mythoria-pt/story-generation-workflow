# Fix Orphaned Runs Script
# This script helps identify and fix runs that reference non-existent stories

param(
    [switch]$DryRun = $false,
    [switch]$Verbose = $false
)

Write-Host "🔍 Checking for orphaned workflow runs..." -ForegroundColor Yellow

# Set up environment
$env:NODE_ENV = "development"
$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptPath

Set-Location $projectRoot

# Function to run database queries
function Invoke-DatabaseQuery {
    param([string]$Query, [string]$Database = "main")
    
    if ($Database -eq "workflows") {
        $connectionString = $env:WORKFLOWS_DATABASE_URL
    } else {
        $connectionString = $env:DATABASE_URL
    }
    
    if (-not $connectionString) {
        Write-Error "Database connection string not found for $Database database"
        return $null
    }
    
    try {
        # Use psql to run the query
        $result = psql $connectionString -c $Query -t
        return $result
    } catch {
        Write-Error "Failed to run query: $_"
        return $null
    }
}

Write-Host "📊 Analyzing orphaned runs..." -ForegroundColor Blue

# Check for runs with non-existent stories
$orphanedRunsQuery = @"
SELECT 
    sgr.run_id,
    sgr.story_id,
    sgr.status,
    sgr.current_step,
    sgr.created_at
FROM story_generation_runs sgr
WHERE sgr.story_id NOT IN (
    SELECT s.story_id 
    FROM stories s
);
"@

Write-Host "🔍 Querying orphaned runs..." -ForegroundColor Gray
$orphanedRuns = Invoke-DatabaseQuery -Query $orphanedRunsQuery -Database "workflows"

if ($orphanedRuns) {
    Write-Host "⚠️  Found orphaned runs:" -ForegroundColor Red
    Write-Host $orphanedRuns
    
    if (-not $DryRun) {
        $cleanup = Read-Host "Do you want to clean up these orphaned runs? (y/N)"
        if ($cleanup -eq 'y' -or $cleanup -eq 'Y') {
            Write-Host "🧹 Cleaning up orphaned runs..." -ForegroundColor Yellow
            
            $cleanupQuery = @"
DELETE FROM story_generation_runs 
WHERE story_id NOT IN (
    SELECT s.story_id 
    FROM stories s
);
"@
            
            $result = Invoke-DatabaseQuery -Query $cleanupQuery -Database "workflows"
            Write-Host "✅ Orphaned runs cleaned up" -ForegroundColor Green
        }
    } else {
        Write-Host "🔍 [DRY RUN] Would clean up orphaned runs" -ForegroundColor Yellow
    }
} else {
    Write-Host "✅ No orphaned runs found" -ForegroundColor Green
}

# Check for failed runs that might need attention
Write-Host "`n📊 Checking failed runs..." -ForegroundColor Blue

$failedRunsQuery = @"
SELECT 
    sgr.run_id,
    sgr.story_id,
    sgr.error_message,
    sgr.current_step,
    sgr.created_at
FROM story_generation_runs sgr
WHERE sgr.status = 'failed'
ORDER BY sgr.created_at DESC
LIMIT 10;
"@

$failedRuns = Invoke-DatabaseQuery -Query $failedRunsQuery -Database "workflows"

if ($failedRuns) {
    Write-Host "⚠️  Recent failed runs:" -ForegroundColor Yellow
    Write-Host $failedRuns
} else {
    Write-Host "✅ No recent failed runs found" -ForegroundColor Green
}

# Check for stories without chapter count
Write-Host "`n📊 Checking stories without chapter count..." -ForegroundColor Blue

$missingChapterCountQuery = @"
SELECT 
    s.story_id,
    s.title,
    s.chapter_count,
    s.created_at
FROM stories s
WHERE s.chapter_count IS NULL OR s.chapter_count = 0
ORDER BY s.created_at DESC
LIMIT 10;
"@

$missingChapterCount = Invoke-DatabaseQuery -Query $missingChapterCountQuery -Database "main"

if ($missingChapterCount) {
    Write-Host "⚠️  Stories without chapter count:" -ForegroundColor Yellow
    Write-Host $missingChapterCount
    
    if (-not $DryRun) {
        $fix = Read-Host "Do you want to set default chapter count (6) for these stories? (y/N)"
        if ($fix -eq 'y' -or $fix -eq 'Y') {
            Write-Host "🔧 Setting default chapter count..." -ForegroundColor Yellow
            
            $fixQuery = @"
UPDATE stories 
SET chapter_count = 6 
WHERE chapter_count IS NULL OR chapter_count = 0;
"@
            
            $result = Invoke-DatabaseQuery -Query $fixQuery -Database "main"
            Write-Host "✅ Default chapter count set" -ForegroundColor Green
        }
    } else {
        Write-Host "🔍 [DRY RUN] Would set default chapter count" -ForegroundColor Yellow
    }
} else {
    Write-Host "✅ All stories have chapter count set" -ForegroundColor Green
}

Write-Host "`n✨ Analysis complete!" -ForegroundColor Green
Write-Host "💡 To run in dry-run mode: .\scripts\fix-orphaned-runs.ps1 -DryRun" -ForegroundColor Gray
Write-Host "💡 For verbose output: .\scripts\fix-orphaned-runs.ps1 -Verbose" -ForegroundColor Gray
