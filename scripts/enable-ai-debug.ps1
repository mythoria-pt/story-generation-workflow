#!/usr/bin/env pwsh

# Script to enable AI debugging
# This sets environment variables for full AI request/response logging

Write-Host "Enabling AI Debug Mode..." -ForegroundColor Yellow

# Set environment variables for full debugging
$env:DEBUG_AI_FULL_PROMPTS = "true"
$env:DEBUG_AI_FULL_RESPONSES = "true"

Write-Host "AI Debug mode enabled!" -ForegroundColor Green
Write-Host "The following environment variables are now set:" -ForegroundColor Cyan
Write-Host "  DEBUG_AI_FULL_PROMPTS=$env:DEBUG_AI_FULL_PROMPTS" -ForegroundColor Gray
Write-Host "  DEBUG_AI_FULL_RESPONSES=$env:DEBUG_AI_FULL_RESPONSES" -ForegroundColor Gray
Write-Host ""
Write-Host "To disable debug mode, run:" -ForegroundColor Yellow
Write-Host "  Remove-Item Env:DEBUG_AI_FULL_PROMPTS" -ForegroundColor Gray
Write-Host "  Remove-Item Env:DEBUG_AI_FULL_RESPONSES" -ForegroundColor Gray
Write-Host ""
Write-Host "Note: This will log full prompts and responses to the console." -ForegroundColor Yellow
Write-Host "Be careful with sensitive data and log file sizes." -ForegroundColor Yellow
