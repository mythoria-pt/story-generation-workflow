# AGENTS.md

## Overview
Story Generation Workflow is a Node.js service that orchestrates AI providers to build stories with text, images, and audio.

## Development
- Node.js >= 22
- Install dependencies: `npm install`
- Start dev server: `npm run dev`

## Testing
- Lint: `npm run lint`
- Unit tests: `npm test`
- Validate environment: `npm run env:validate`

## Code Style
- TypeScript with ES modules
- 2 spaces, single quotes, and semicolons
- Format with Prettier: `npm run format`

## Architecture
- `src/shared`: pure business logic, no external dependencies
- `src/adapters`: implementations for external services
- `src/ai`: provider-specific AI services
- `src/routes`: Express handlers

## PR Guidelines
- Run lint and tests before committing
- Add or update tests for changed code
