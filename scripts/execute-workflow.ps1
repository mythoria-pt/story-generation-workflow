# Execute the story-generation workflow
# Usage: .\execute-workflow.ps1 -StoryId "story123" -Prompt "A magical adventure"

param(
    [Parameter(Mandatory=$true)]
    [string]$StoryId,
    
    [Parameter(Mandatory=$true)]
    [string]$Prompt,
    
    [string]$BaseUrl = "https://story-generation-workflow-803421888801.us-central1.run.app",
    
    [string]$Location = "europe-west9"
)

$workflowId = [System.Guid]::NewGuid().ToString()

# Create the request JSON
$requestData = @{
    storyId = $StoryId
    workflowId = $workflowId
    baseUrl = $BaseUrl
    prompt = $Prompt
} | ConvertTo-Json -Depth 10

# Write request data to a temporary file
$tempFile = [System.IO.Path]::GetTempFileName()
$requestData | Out-File -FilePath $tempFile -Encoding UTF8

Write-Host "Executing workflow with:"
Write-Host "  Story ID: $StoryId"
Write-Host "  Workflow ID: $workflowId"
Write-Host "  Base URL: $BaseUrl"
Write-Host "  Prompt: $Prompt"
Write-Host ""

try {
    # Execute the workflow
    $result = gcloud workflows execute mythoria-story-generation --location=$Location --data-file=$tempFile --format=json | ConvertFrom-Json
    
    Write-Host "Workflow execution started successfully!"
    Write-Host "Execution name: $($result.name)"
    Write-Host ""
    
    # Wait for completion and show result
    Write-Host "Waiting for workflow to complete..."
    gcloud workflows executions wait $result.name --location=$Location --workflow=mythoria-story-generation
    
    # Get the final result
    $finalResult = gcloud workflows executions describe $result.name --location=$Location --workflow=mythoria-story-generation --format=json | ConvertFrom-Json
    
    Write-Host "Workflow completed with state: $($finalResult.state)"
    if ($finalResult.result) {
        Write-Host "Result:"
        Write-Host $finalResult.result
    }
    
    if ($finalResult.error) {
        Write-Host "Error:"
        Write-Host $finalResult.error
    }
    
} catch {
    Write-Error "Failed to execute workflow: $_"
} finally {
    # Clean up temp file
    if (Test-Path $tempFile) {
        Remove-Item $tempFile
    }
}
