#!/usr/bin/env pwsh

# Script to disable AI debugging
# This removes environment variables for full AI request/response logging

Write-Host "Disabling AI Debug Mode..." -ForegroundColor Yellow

# Remove environment variables
Remove-Item Env:DEBUG_AI_FULL_PROMPTS -ErrorAction SilentlyContinue
Remove-Item Env:DEBUG_AI_FULL_RESPONSES -ErrorAction SilentlyContinue

Write-Host "AI Debug mode disabled!" -ForegroundColor Green
Write-Host "Full prompt and response logging has been turned off." -ForegroundColor Cyan
Write-Host "Basic debug information will still be logged at INFO level." -ForegroundColor Gray
