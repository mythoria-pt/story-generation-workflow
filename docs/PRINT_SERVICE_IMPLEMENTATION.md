# Print Service Implementation

This implementation adds PDF generation for print-ready books to the Mythoria story generation workflow.

## Overview

The print service generates two PDF files per book:
1. **Interior-block.pdf** - All numbered pages with 3mm bleed
2. **Cover-spread.pdf** - Back cover + spine + front cover with 20mm bleed

## Components Added

### 1. Database Schema Updates
- Added `interiorPdfUri` and `coverPdfUri` fields to stories table
- Migration: `0014_lumpy_king_bedlam.sql`

### 2. Print Service (`src/services/print.ts`)
- Calculates print dimensions based on page count and paper type
- Generates HTML templates for interior and cover
- Uses Puppeteer to render PDFs
- Configurable paper caliper settings

### 3. Workflow Integration
- New workflow: `workflows/print-generation.yaml`
- Print handlers in `src/workflows/handlers.ts`
- REST endpoint: `/internal/print/generate`

### 4. Pub/Sub Integration
- New topic: `mythoria-print-requests`
- Triggered automatically when print orders are placed
- Async PDF generation workflow

### 5. Configuration
- Paper caliper settings: `config/paper-caliper.json`
- Default: 170x240mm trim size, 3mm interior bleed, 20mm cover bleed

## Usage

### Manual API Call
```bash
POST /internal/print/generate
{
  "storyId": "uuid",
  "workflowId": "uuid"
}
```

### Automatic Trigger
PDFs are automatically generated when users place print orders through the webapp.

## Key Features

- **Proper bleed handling** (3mm interior, 20mm cover)
- **Spine width calculation** based on page count and paper caliper
- **Professional typography** with serif fonts
- **Table of contents** with page numbers
- **Chapter formatting** starting on recto pages
- **Dedication page** with custom author and Mythoria branding

## Dependencies Added

- `puppeteer` - PDF generation
- `@google-cloud/pubsub` - Pub/Sub messaging

## File Structure

```
config/
  paper-caliper.json          # Paper specifications
src/services/
  print.ts                    # Core print service
src/routes/
  print.ts                    # REST API endpoints
src/workflows/
  handlers.ts                 # Updated with print handlers
workflows/
  print-generation.yaml       # Google Workflows definition
```

## Configuration Details

The system uses a simple paper caliper configuration that can be updated by admins:

```json
{
  "paperTypes": {
    "coated_115gsm": {
      "name": "115 g/m² Coated",
      "caliper": 0.09,
      "description": "Standard coated paper for color printing"
    }
  },
  "defaultPaperType": "coated_115gsm",
  "bleedMM": {
    "interior": 3,
    "cover": 20
  },
  "safeZoneMM": 10,
  "trimSize": {
    "width": 170,
    "height": 240
  }
}
```

## Next Steps

1. Deploy the updated workflow to Google Cloud
2. Create the `mythoria-print-requests` Pub/Sub topic
3. Test the complete print generation pipeline
4. Add monitoring and error handling
5. Implement print provider integrations
