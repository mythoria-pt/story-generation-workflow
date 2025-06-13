# Test the story-generation workflow with sample data
# This script runs a simple test to verify the workflow is working

Write-Host "Testing story-generation workflow..." -ForegroundColor Green

$testStoryId = "test-story-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
$testPrompt = "A young wizard discovers a magical book that can bring stories to life."

Write-Host "Running test with Story ID: $testStoryId" -ForegroundColor Yellow

try {
    # Execute the test
    .\execute-workflow.ps1 -StoryId $testStoryId -Prompt $testPrompt
    
    Write-Host "Test completed successfully!" -ForegroundColor Green
    
} catch {
    Write-Host "Test failed: $_" -ForegroundColor Red
    exit 1
}
