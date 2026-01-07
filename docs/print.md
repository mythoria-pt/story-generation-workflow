# Print & CMYK Pipeline

SGW produces two PDF sets per story—RGB (screen) and CMYK (print-ready)—and stores them alongside other assets in Google Cloud Storage. This document merges the former implementation notes, CMYK conversion guide, and troubleshooting checklist.

## Components & flow

1. **Print service** (`src/services/print.ts`) renders HTML templates into `interior.pdf` and `cover.pdf` via Puppeteer using trim-size + paper-caliper data from `src/config/paper-caliper.json`.
2. **CMYK conversion service** (`src/services/cmyk-conversion.ts`) calls Ghostscript to turn each RGB PDF into PDF/X‑1a compliant CMYK variants (`*-cmyk.pdf`).
3. **Workflow** (`workflows/print-generation.yaml`) drives the request by hitting `POST /internal/print/generate`, then returns public URLs for RGB + CMYK assets.
4. **Storage layout**: `{storyId}/print/interior.pdf`, `{storyId}/print/cover.pdf`, and matching `*-cmyk.pdf` outputs plus HTML debug files.

### Self-print workflow hooks

- `POST /print/self-service` receives requests from the web app, dedupes recipients (author auto-added when possible), and launches `print-generation`. Every accepted request logs `Self-print workflow enqueued` with `storyId`, `workflowId`, `executionId`, and the number of recipients to simplify refunds.
- The workflow payload contains `delivery` metadata (locale, requestedBy, etc.) so `print-generation.yaml` can call `/internal/print/self-service/notify` after PDFs upload. That route attaches Cloud Storage URLs and emits `Self-print notification dispatched` logs carrying `storyId`, `runId`, `executionId`, and `sent` status.
- `RunsService` persists `gcpWorkflowExecution` (Cloud Workflows execution id) allowing Notification Engine to echo the identifier back inside `metadata.workflowExecutionId` for observability dashboards.

## Configuration checklist

| Item           | Notes                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ghostscript    | Install locally or bake into Docker; point `GHOSTSCRIPT_BINARY` to `gs` (Linux) or `gswin64c.exe` (Windows).                                                                         |
| Temp directory | `TEMP_DIR` defaults to system temp. Override (e.g., `/tmp/mythoria-print`) if the container needs a dedicated mount.                                                                 |
| ICC profiles   | `npm run setup-icc-profiles` downloads CoatedFOGRA39, ISOcoated_v2_eci, etc. Production Docker builds copy files under `icc-profiles/` and reference `src/config/icc-profiles.json`. |
| Paper config   | `paper-caliper.json` defines trim size (170×240mm), bleed, safe zones, and caliper used for spine width math.                                                                        |
| Pub/Sub        | Print jobs can be triggered by webapp orders via topic `mythoria-print-requests`, which in turn calls the workflow.                                                                  |

## CMYK conversion specifics

- Default profile: **CoatedFOGRA39** (ISO 12647-2:2013). Placeholder files are detected by size; if missing, the service falls back to Ghostscript’s built-in CMYK strategy so jobs still complete.
- Ghostscript command (simplified to avoid Windows quoting issues):

  ```powershell
  gswin64c.exe -dNOPAUSE -dBATCH -dSAFER -dQUIET `
    -sDEVICE=pdfwrite `
    -dCompatibilityLevel=1.4 `
    -sColorConversionStrategy=CMYK `
    -sProcessColorModel=DeviceCMYK `
    -dOverrideICC=true `
    -dRenderIntent=0 `
    -dDeviceGrayToK=true `
    -dPDFX=true `
    -sOutputICCProfile=CoatedFOGRA39.icc `
    -sOutputFile=output-cmyk.pdf `
    metadata.ps input-rgb.pdf
  ```

- When an ICC profile is not available, the service skips `metadata.ps` and still emits CMYK output, logging `"Using built-in CMYK conversion (no ICC profile)"`.
- Errors never break the workflow: failures log `"CMYK conversion failed, continuing with RGB only"` and the API still returns the RGB URLs.
- After CMYK conversion, interior pages are reprocessed so that non-image pages use a **Gray Gamma 2.2** profile while chapter image pages remain in color. The detector favors large, page-filling images (via `pdf-parse` 2.x) and leaves those pages untouched while rerendering text pages in grayscale. The Gray profile ships as `icc-profiles/Generic_Gray_Gamma_2.2_Profile.icc` and is copied into the runtime image alongside the CMYK profiles.
- Image-page detection uses `pdf-parse`’s `getImage()` with a high threshold and then falls back to a low-level `pdf-lib` scan if PDF.js fails (e.g., when WASM workers are restricted). Detected pages (typically the full-bleed chapter illustrations) stay CMYK; all other interior pages are rendered to Gray Gamma 2.2 to preserve true black while keeping PDF/X‑1a conformance.

## Testing & validation

| Intent                         | Command                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| Verify Ghostscript presence    | `pwsh -NoProfile -Command "npm run test:ghostscript"`                                       |
| Render sample PDFs & convert   | `pwsh -NoProfile -Command "npm run test:cmyk"`                                              |
| Check ICC + Ghostscript health | `pwsh -NoProfile -Command "npm run cmyk:status"`                                            |
| Exercise API                   | Call `POST /internal/print/generate` with `generateCMYK: true` while running `npm run dev`. |

### Deployment tips

- Allocate **2 vCPU / 2–4 GiB RAM** on Cloud Run; CMYK conversion peaks around ~500 MB per PDF.
- Set request timeout ≥900 s; large interiors need time for Puppeteer + Ghostscript.
- `npm run deploy` already installs Ghostscript and copies ICC profiles inside the image; rerun `npm run setup-icc-profiles` locally before baking new builds to avoid drifting artifacts.

## Troubleshooting

| Symptom                                      | Likely cause                                                        | Fix                                                                                                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Command failed: gswin64c.exe ...`           | Ghostscript missing, wrong path, or placeholder ICC treated as real | Install Ghostscript, update `GHOSTSCRIPT_BINARY`, or rerun `npm run setup-icc-profiles`. Placeholder files are auto-detected but confirm file size >100 KB. |
| `Using built-in CMYK conversion` log in prod | ICC not bundled into image                                          | Ensure Docker build copies `icc-profiles/` and `src/config/icc-profiles.json` points to valid filenames.                                                    |
| Temp-file permission errors                  | `TEMP_DIR` unwritable inside container                              | Set `TEMP_DIR=/tmp/mythoria-print` and ensure the Cloud Run service account can write there.                                                                |
| Cover alignment issues                       | Paper caliper or trim settings mismatched to provider spec          | Adjust `src/config/paper-caliper.json` and redeploy; confirm bleed = 3 mm and safe zone 10 mm per current assumptions.                                      |

## Reference outputs

Each successful run uploads:

- `interior.pdf` / `cover.pdf` – RGB reference versions for web preview.
- `interior-cmyk.pdf` / `cover-cmyk.pdf` – PDF/X‑1a CMYK files ready for print submission.
- `interior.html` / `cover.html` – Debug HTML snapshots.

Review artifacts in Cloud Storage before shipping to printers, especially after updating templates or caliper data.
