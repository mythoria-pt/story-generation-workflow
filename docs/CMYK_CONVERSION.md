# CMYK Conversion Implementation

This document describes the CMYK conversion feature added to the Mythoria story generation workflow.

## Overview

The CMYK conversion feature converts RGB PDFs to CMYK PDF/X-1a format suitable for professional printing. This ensures color consistency and print compatibility across different print providers.

## Key Features

- **RGB to CMYK conversion** using Ghostscript
- **PDF/X-1a compliance** with proper metadata
- **CoatedFOGRA39 ICC profile** (ISO 12647-2:2013) for color accuracy
- **Dual output**: Both RGB and CMYK versions are generated
- **Professional print metadata** embedded in PDFs
- **Automatic cleanup** of temporary files

## Architecture

### Components

1. **CMYKConversionService** (`src/services/cmyk-conversion.ts`)
   - Handles Ghostscript execution
   - Manages ICC profiles
   - Generates PDF/X metadata
   - Handles temporary file management

2. **Enhanced PrintService** (`src/services/print.ts`)
   - Integrates CMYK conversion
   - Manages print workflow
   - Handles both RGB and CMYK generation

3. **Updated Workflow** (`workflows/print-generation.yaml`)
   - Supports CMYK generation flag
   - Returns URLs for both RGB and CMYK PDFs

4. **Docker Integration** (`Dockerfile`)
   - Includes Ghostscript installation
   - Downloads ICC profiles
   - Sets up proper permissions

## Configuration

### ICC Profiles

Located in `src/config/icc-profiles.json`:

```json
{
  "profiles": {
    "CoatedFOGRA39": {
      "name": "Coated FOGRA39 (ISO 12647-2:2013)",
      "filename": "CoatedFOGRA39.icc",
      "description": "Standard European commercial printing on coated paper"
    }
  },
  "defaultProfile": "CoatedFOGRA39"
}
```

### Environment Variables

- `GHOSTSCRIPT_BINARY`: Path to Ghostscript executable (default: `gs` on Linux, `gswin64c.exe` on Windows)
- `TEMP_DIR`: Directory for temporary files (default: system temp directory)

## Usage

### API Endpoint

```http
POST /internal/print/generate
Content-Type: application/json

{
  "storyId": "uuid",
  "workflowId": "uuid",
  "generateCMYK": true
}
```

### Response Format

```json
{
  "interiorPdfUrl": "https://storage.../interior.pdf",
  "coverPdfUrl": "https://storage.../cover.pdf",
  "interiorCmykPdfUrl": "https://storage.../interior-cmyk.pdf",
  "coverCmykPdfUrl": "https://storage.../cover-cmyk.pdf",
  "status": "completed"
}
```

### Workflow Integration

The Google Workflow automatically triggers CMYK conversion:

```yaml
- generatePrintPDFs:
    call: http.request
    args:
      body:
        storyId: ${storyId}
        workflowId: ${runId}
        generateCMYK: true
```

## Development Setup

### 1. Install Dependencies

```bash
npm install tmp @types/tmp
```

### 2. Setup ICC Profiles

```bash
npm run setup-icc-profiles
```

### 3. Install Ghostscript (Windows)

- Download from https://www.ghostscript.com/download/gsdnld.html
- Add to PATH environment variable
- Verify: `gswin64c.exe --version`

### 4. Test Local Setup

```bash
npm run test:cmyk
```

## Deployment

### Enhanced Deployment Script

```bash
npm run deploy:cmyk
```

This script:

1. Sets up ICC profiles
2. Builds Docker image with Ghostscript
3. Deploys to Cloud Run with CMYK support
4. Configures environment variables

### Manual Deployment

```bash
# Build and deploy
docker build -t gcr.io/PROJECT_ID/story-generation-workflow .
docker push gcr.io/PROJECT_ID/story-generation-workflow

gcloud run deploy story-generation-workflow \
  --image gcr.io/PROJECT_ID/story-generation-workflow \
  --set-env-vars NODE_ENV=production,GHOSTSCRIPT_BINARY=gs,TEMP_DIR=/tmp/mythoria-print \
  --memory 2Gi \
  --cpu 2 \
  --timeout 900
```

## Testing

### Local Environment Test

```bash
npm run test:cmyk
```

### Service Endpoint Test

```bash
npm run test:cmyk:service
```

### Manual Ghostscript Test

```bash
# Test Ghostscript installation
gswin64c.exe --version

# Test ICC profile
ls icc-profiles/CoatedFOGRA39.icc
```

## File Outputs

### RGB PDFs (Original)

- `interior.pdf`: Standard RGB PDF for screen viewing
- `cover.pdf`: Standard RGB PDF for screen viewing

### CMYK PDFs (Print-Ready)

- `interior-cmyk.pdf`: PDF/X-1a compliant, CMYK color space
- `cover-cmyk.pdf`: PDF/X-1a compliant, CMYK color space

### HTML Debug Files

- `interior.html`: HTML source for debugging layout
- `cover.html`: HTML source for debugging layout

## Technical Details

### Ghostscript Command

```bash
gs -dNOPAUSE -dBATCH -dSAFER -dQUIET \
   -sDEVICE=pdfwrite \
   -dCompatibilityLevel=1.4 \
   -sColorConversionStrategy=CMYK \
   -sProcessColorModel=DeviceCMYK \
   -dOverrideICC=true \
   -dRenderIntent=0 \
   -dDeviceGrayToK=true \
   -dPDFX=true \
   -sOutputICCProfile=CoatedFOGRA39.icc \
   -sOutputFile=output-cmyk.pdf \
   metadata.ps \
   input-rgb.pdf
```

### PDF/X Metadata

```postscript
[/Title (Story Title)
 /Author (Author Name)
 /Subject (Print-ready story book)
 /Creator (Mythoria Print Service)
 /OutputConditionIdentifier (Coated FOGRA39)
 /OutputCondition (Standard European commercial printing)
 /RegistryName (http://www.color.org)
 /Trapped /False
 DOCINFO pdfmark
```

## Error Handling

### Common Issues

1. **Ghostscript not found**
   - Install Ghostscript
   - Add to PATH
   - Set `GHOSTSCRIPT_BINARY` environment variable

2. **ICC profile missing**
   - Download CoatedFOGRA39.icc manually
   - Place in `icc-profiles/` directory
   - Verify file size > 100KB

3. **Memory issues**
   - Increase Cloud Run memory to 2Gi
   - Set timeout to 900 seconds
   - Monitor temp directory usage

4. **Permission errors**
   - Ensure temp directory permissions
   - Check Docker user permissions
   - Verify file cleanup

### Fallback Behavior

If CMYK conversion fails, the system:

1. Logs the error
2. Continues with RGB PDFs only
3. Returns partial results
4. Doesn't fail the entire workflow

## Performance Considerations

- **Conversion time**: 10-30 seconds per PDF
- **Memory usage**: ~500MB additional for conversion
- **Storage**: CMYK PDFs are typically 10-20% larger
- **Parallel processing**: Interior and cover converted simultaneously

## Monitoring

### Key Metrics

- CMYK conversion success rate
- Conversion time per PDF
- Memory usage during conversion
- Temporary file cleanup success

### Logs to Monitor

```
"CMYK conversion completed successfully"
"Ghostscript validation successful"
"ICC profile verified"
"Temporary directory cleanup completed"
```

## Future Enhancements

1. **Multiple ICC profiles** for different print conditions
2. **Color validation** tools for print readiness
3. **Preflight checks** for PDF/X compliance
4. **Batch conversion** for multiple stories
5. **Color management** workflow integration

## Troubleshooting

### Debug Mode

Set `NODE_ENV=development` for detailed logging:

```bash
export NODE_ENV=development
npm run dev
```

### Manual Testing

```bash
# Test Ghostscript directly
gswin64c.exe -dNOPAUSE -dBATCH -sDEVICE=pdfwrite \
  -sColorConversionStrategy=CMYK \
  -sOutputFile=test-cmyk.pdf \
  input.pdf

# Verify PDF/X compliance
gs -dNOPAUSE -dBATCH -sDEVICE=nullpage \
   -dPDFX -sOutputFile=- test-cmyk.pdf
```

## Support

For issues with CMYK conversion:

1. Check Ghostscript installation
2. Verify ICC profile presence
3. Review logs for specific errors
4. Test with sample PDF files
5. Contact development team with error details
