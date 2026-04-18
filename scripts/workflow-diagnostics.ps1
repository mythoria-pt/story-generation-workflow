# Workflow Diagnostics Script
# Comprehensive script to diagnose and fix the specific issues from the logs

param(
    [string]$RunId = "",
    [string]$StoryId = "",
    [switch]$Fix = $false,
    [switch]$Verbose = $false
)

Write-Host "🔬 Story Generation Workflow Diagnostics" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

$env:NODE_ENV = "development"
$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptPath

Set-Location $projectRoot

# If specific IDs are provided, use them
if ($RunId) {
    Write-Host "🎯 Targeting specific run: $RunId" -ForegroundColor Yellow
}
if ($StoryId) {
    Write-Host "🎯 Targeting specific story: $StoryId" -ForegroundColor Yellow
}

# Create diagnostics script
$diagnosticsScript = @"
const { getDatabase } = require('./dist/db/connection.js');
const { getWorkflowsDatabase } = require('./dist/db/connection.js');

async function runDiagnostics() {
    try {
        const mainDb = getDatabase();
        const workflowDb = getWorkflowsDatabase();
        
        console.log('🔍 COMPREHENSIVE WORKFLOW DIAGNOSTICS');
        console.log('=====================================\\n');
        
        // Specific run analysis if provided
        const targetRunId = '$RunId';
        const targetStoryId = '$StoryId';
        
        if (targetRunId) {
            console.log('🎯 ANALYZING SPECIFIC RUN:', targetRunId);
            console.log('-----------------------------------');
            
            // Get run details
            const runQuery = 'SELECT * FROM story_generation_runs WHERE run_id = ?' + ' LIMIT 1';
            const runResult = await workflowDb.execute(runQuery, [targetRunId]);
            
            if (runResult.rows.length > 0) {
                const run = runResult.rows[0];
                console.log('📋 Run Details:');
                console.log('   ID:', run.run_id);
                console.log('   Story ID:', run.story_id);
                console.log('   Status:', run.status);
                console.log('   Current Step:', run.current_step);
                console.log('   Error:', run.error_message || 'None');
                console.log('   Created:', run.created_at);
                console.log('   Updated:', run.updated_at);
                
                // Check if story exists
                const storyQuery = 'SELECT story_id, title, chapter_count FROM stories WHERE story_id = ?' + ' LIMIT 1';
                const storyResult = await mainDb.execute(storyQuery, [run.story_id]);
                
                if (storyResult.rows.length > 0) {
                    const story = storyResult.rows[0];
                    console.log('\\n📚 Associated Story:');
                    console.log('   ID:', story.story_id);
                    console.log('   Title:', story.title || 'No title');
                    console.log('   Chapter Count:', story.chapter_count || 'Not set');
                    console.log('   ✅ Story exists in main database');
                } else {
                    console.log('\\n❌ PROBLEM: Associated story does not exist!');
                    console.log('   This is an ORPHANED RUN');
                    console.log('   Recommended action: Cancel this run');
                }
                
                // Check run steps
                const stepsQuery = 'SELECT * FROM story_generation_steps WHERE run_id = ?' + ' ORDER BY created_at';
                const stepsResult = await workflowDb.execute(stepsQuery, [targetRunId]);
                
                console.log('\\n📝 Run Steps (' + stepsResult.rows.length + ' total):');
                for (const step of stepsResult.rows) {
                    console.log('   ' + step.step_name + ': ' + step.status + (step.started_at ? ' (started: ' + step.started_at + ')' : ''));
                }
            } else {
                console.log('❌ Run not found in workflows database');
            }
        }
        
        console.log('\\n🔍 GENERAL HEALTH CHECK');
        console.log('========================');
        
        // Check for orphaned runs
        const orphanedQuery = `
            SELECT 
                sgr.run_id, 
                sgr.story_id, 
                sgr.status, 
                sgr.current_step,
                sgr.error_message,
                sgr.created_at
            FROM story_generation_runs sgr
            WHERE sgr.story_id NOT IN (
                SELECT s.story_id FROM stories s
            )
            ORDER BY sgr.created_at DESC
            LIMIT 10
        `;
        
        const orphanedResult = await workflowDb.execute(orphanedQuery);
        console.log('\\n👻 Orphaned Runs (top 10):');
        if (orphanedResult.rows.length > 0) {
            console.log('   ❌ Found ' + orphanedResult.rows.length + ' orphaned runs:');
            for (const run of orphanedResult.rows) {
                console.log('   - ' + run.run_id + ' (story: ' + run.story_id + ', status: ' + run.status + ')');
            }
        } else {
            console.log('   ✅ No orphaned runs found');
        }
        
        // Check for failed runs with chapter count issues
        const chapterIssuesQuery = `
            SELECT 
                sgr.run_id,
                sgr.story_id,
                sgr.error_message,
                s.title,
                s.chapter_count
            FROM story_generation_runs sgr
            JOIN stories s ON sgr.story_id = s.story_id
            WHERE sgr.status = 'failed' 
            AND (sgr.error_message LIKE '%chapter%' OR s.chapter_count IS NULL OR s.chapter_count = 0)
            ORDER BY sgr.created_at DESC
            LIMIT 5
        `;
        
        const chapterIssuesResult = await workflowDb.execute(chapterIssuesQuery);
        console.log('\\n📖 Chapter Count Issues:');
        if (chapterIssuesResult.rows.length > 0) {
            console.log('   ⚠️  Found ' + chapterIssuesResult.rows.length + ' runs with chapter issues:');
            for (const run of chapterIssuesResult.rows) {
                console.log('   - ' + run.run_id + ': "' + (run.title || 'No title') + '" (chapters: ' + (run.chapter_count || 'None') + ')');
            }
        } else {
            console.log('   ✅ No chapter count issues found');
        }
        
        // Check for stuck running runs
        const stuckRunsQuery = `
            SELECT 
                run_id,
                story_id,
                current_step,
                started_at,
                updated_at
            FROM story_generation_runs
            WHERE status = 'running' 
            AND updated_at < NOW() - INTERVAL '1 hour'
            ORDER BY updated_at
        `;
        
        const stuckRunsResult = await workflowDb.execute(stuckRunsQuery);
        console.log('\\n⏰ Potentially Stuck Runs (running > 1h):');
        if (stuckRunsResult.rows.length > 0) {
            console.log('   ⚠️  Found ' + stuckRunsResult.rows.length + ' potentially stuck runs:');
            for (const run of stuckRunsResult.rows) {
                console.log('   - ' + run.run_id + ' (step: ' + (run.current_step || 'unknown') + ', updated: ' + run.updated_at + ')');
            }
        } else {
            console.log('   ✅ No stuck runs found');
        }
        
        console.log('\\n📊 SUMMARY STATISTICS');
        console.log('=====================');
        
        // Total counts
        const stats = await Promise.all([
            mainDb.execute('SELECT COUNT(*) as count FROM stories'),
            workflowDb.execute('SELECT COUNT(*) as count FROM story_generation_runs'),
            workflowDb.execute('SELECT COUNT(*) as count FROM story_generation_runs WHERE status = \'failed\''),
            workflowDb.execute('SELECT COUNT(*) as count FROM story_generation_runs WHERE status = \'running\''),
            workflowDb.execute('SELECT COUNT(*) as count FROM story_generation_runs WHERE status = \'completed\''),
            mainDb.execute('SELECT COUNT(*) as count FROM stories WHERE chapter_count IS NULL OR chapter_count = 0')
        ]);
        
        console.log('📚 Total Stories:', stats[0].rows[0].count);
        console.log('🔄 Total Workflow Runs:', stats[1].rows[0].count);
        console.log('❌ Failed Runs:', stats[2].rows[0].count);
        console.log('🏃 Running Runs:', stats[3].rows[0].count);
        console.log('✅ Completed Runs:', stats[4].rows[0].count);
        console.log('📖 Stories without chapter count:', stats[5].rows[0].count);
        
        process.exit(0);
        
    } catch (error) {
        console.error('❌ Diagnostics failed:', error.message);
        if ('$Verbose' === 'True') {
            console.error('Stack trace:', error.stack);
        }
        process.exit(1);
    }
}

runDiagnostics();
"@

Write-Host "🔨 Building project..." -ForegroundColor Gray
npm run build --silent

Write-Host "🏃 Running diagnostics..." -ForegroundColor Blue
$result = node -e $diagnosticsScript

if ($result) {
    Write-Host $result
}

# Recommendations based on the logs you provided
Write-Host "`n💡 RECOMMENDATIONS BASED ON YOUR LOGS:" -ForegroundColor Yellow
Write-Host "=====================================`n" -ForegroundColor Yellow

Write-Host "1. 🎯 For Run ID: 4b0f0dfb-07dd-45bb-b7bf-e94f70cd6163" -ForegroundColor White
Write-Host "   Story ID: 3251c7d5-9c10-481c-afd1-e2ac78285f37" -ForegroundColor White
Write-Host "   Issue: Story not found (404 error)" -ForegroundColor Red
Write-Host "   Action: Check if this story exists in main database" -ForegroundColor Green

Write-Host "`n2. 🔄 Repeated Chapter Count Warnings" -ForegroundColor White
Write-Host "   Issue: Multiple calls to getChapterCount() falling back to default" -ForegroundColor Red
Write-Host "   Action: Ensure stories have proper chapter_count values" -ForegroundColor Green

Write-Host "`n3. 🗃️  Excessive Database Queries" -ForegroundColor White
Write-Host "   Issue: Same queries repeated multiple times" -ForegroundColor Red
Write-Host "   Action: Our caching improvements should help with this" -ForegroundColor Green

if ($Fix) {
    Write-Host "`n🔧 Auto-fix mode enabled, running fixes..." -ForegroundColor Yellow
    
    # Run the orphaned runs cleanup
    Write-Host "Running orphaned runs cleanup..." -ForegroundColor Gray
    & "$scriptPath\fix-orphaned-runs.ps1"
    
    Write-Host "`n✅ Auto-fixes completed!" -ForegroundColor Green
}

Write-Host "`n🎯 NEXT STEPS:" -ForegroundColor Cyan
Write-Host "1. Run this script with -RunId '4b0f0dfb-07dd-45bb-b7bf-e94f70cd6163' to analyze the specific failing run" -ForegroundColor White
Write-Host "2. Check if story '3251c7d5-9c10-481c-afd1-e2ac78285f37' exists in your main database" -ForegroundColor White
Write-Host "3. Run the fix script: .\scripts\fix-orphaned-runs.ps1" -ForegroundColor White
Write-Host "4. Monitor logs for the improved error handling and caching" -ForegroundColor White

Write-Host "`n✨ Diagnostics complete!" -ForegroundColor Green
