# Database Health Check Script
# This script validates the current state of the story generation workflow

param(
    [switch]$Fix = $false,
    [switch]$Verbose = $false
)

Write-Host "🏥 Running Database Health Check..." -ForegroundColor Cyan

$env:NODE_ENV = "development"
$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptPath

Set-Location $projectRoot

# Function to run Node.js script for database operations
function Invoke-NodeScript {
    param([string]$Script)
    
    try {
        $result = node -e $Script
        return $result
    } catch {
        Write-Error "Failed to run Node script: $_"
        return $null
    }
}

# Health check script
$healthCheckScript = @"
const { getDatabase } = require('./dist/db/connection.js');
const { getWorkflowsDatabase } = require('./dist/db/connection.js');
const { eq } = require('drizzle-orm');

async function healthCheck() {
    try {
        const mainDb = getDatabase();
        const workflowDb = getWorkflowsDatabase();
        
        console.log('📊 DATABASE HEALTH CHECK REPORT');
        console.log('================================');
        
        // Check main database stories
        const stories = await mainDb.execute('SELECT COUNT(*) as count FROM stories');
        console.log('📚 Total Stories:', stories.rows[0].count);
        
        // Check workflow runs
        const runs = await workflowDb.execute('SELECT COUNT(*) as count FROM story_generation_runs');
        console.log('🔄 Total Workflow Runs:', runs.rows[0].count);
        
        // Check for orphaned runs
        const orphanedRuns = await workflowDb.execute(`
            SELECT COUNT(*) as count FROM story_generation_runs sgr
            WHERE NOT EXISTS (
                SELECT 1 FROM stories s WHERE s.story_id = sgr.story_id
            )
        `);
        console.log('👻 Orphaned Runs:', orphanedRuns.rows[0].count);
        
        // Check failed runs
        const failedRuns = await workflowDb.execute(`
            SELECT COUNT(*) as count FROM story_generation_runs 
            WHERE status = 'failed'
        `);
        console.log('❌ Failed Runs:', failedRuns.rows[0].count);
        
        // Check running runs
        const runningRuns = await workflowDb.execute(`
            SELECT COUNT(*) as count FROM story_generation_runs 
            WHERE status = 'running'
        `);
        console.log('🏃 Running Runs:', runningRuns.rows[0].count);
        
        // Check stories without chapter count
        const noChapterCount = await mainDb.execute(`
            SELECT COUNT(*) as count FROM stories 
            WHERE chapter_count IS NULL OR chapter_count = 0
        `);
        console.log('📖 Stories without chapter count:', noChapterCount.rows[0].count);
        
        // Check recent activity
        const recentActivity = await workflowDb.execute(`
            SELECT 
                status,
                COUNT(*) as count,
                MAX(created_at) as latest
            FROM story_generation_runs 
            WHERE created_at > NOW() - INTERVAL '24 hours'
            GROUP BY status
            ORDER BY count DESC
        `);
        
        console.log('\\n📈 Recent Activity (24h):');
        for (const row of recentActivity.rows) {
            console.log(`   ${row.status}: ${row.count} (latest: ${row.latest})`);
        }
        
        process.exit(0);
    } catch (error) {
        console.error('❌ Health check failed:', error.message);
        process.exit(1);
    }
}

healthCheck();
"@

Write-Host "🔍 Analyzing database state..." -ForegroundColor Blue

# Build the project first to ensure latest code
Write-Host "🔨 Building project..." -ForegroundColor Gray
npm run build 2>$null

if ($LASTEXITCODE -ne 0) {
    Write-Host "⚠️  Build failed, trying with existing dist..." -ForegroundColor Yellow
}

# Run health check
$healthResult = Invoke-NodeScript -Script $healthCheckScript

if ($healthResult) {
    Write-Host $healthResult
} else {
    Write-Error "Failed to run health check"
}

Write-Host "`n🔧 RECOMMENDED ACTIONS:" -ForegroundColor Yellow
Write-Host "1. Run fix-orphaned-runs.ps1 to clean up orphaned workflow runs" -ForegroundColor White
Write-Host "2. Check logs for failed runs: Get-Content logs/app.log | Select-String 'failed'" -ForegroundColor White
Write-Host "3. Monitor running runs that may be stuck" -ForegroundColor White
Write-Host "4. Ensure all stories have proper chapter_count values" -ForegroundColor White

if ($Fix) {
    Write-Host "`n🔧 Auto-fix mode enabled..." -ForegroundColor Yellow
    Write-Host "Running fix-orphaned-runs.ps1..." -ForegroundColor Gray
    & "$scriptPath\fix-orphaned-runs.ps1"
}

Write-Host "`n✅ Health check complete!" -ForegroundColor Green
