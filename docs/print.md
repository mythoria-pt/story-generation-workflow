# Print & CMYK Pipeline

SGW produces two PDF sets per story—RGB (screen) and CMYK (print-ready)—and stores them alongside other assets in Google Cloud Storage. This document merges the former implementation notes, CMYK conversion guide, and troubleshooting checklist.

## Components & flow

1. **Print service** (`src/services/print.ts`) renders HTML templates into `interior.pdf` and `cover.pdf` via Puppeteer using trim-size + paper-caliper data from `src/config/paper-caliper.json`. It now inserts soft hyphen opportunities into large-font chapter HTML (`children_0-2`, `children_3-6`, `children_7-10`) before rendering so justified child-reader layouts can break long words cleanly. It post-processes the interior PDF to enforce page ordering rules (see below) before any color work happens.
2. **CMYK conversion service** (`src/services/cmyk-conversion.ts`) calls Ghostscript to turn each RGB PDF into PDF/X‑1a compliant CMYK variants (`*-cmyk.pdf`). Interior generation now creates a grayscale-only copy for text pages and merges it with full-CMYK image pages so non-art pages stay K-only.
3. **Print QA service** (`src/services/print-quality.ts`) runs immediately after generation. It downloads the freshly generated PDFs/HTML from GCS, applies deterministic layout checks, tries bounded interior-only reflow fixes for sparse chapter endings, renders preview images for multimodal review, and uploads `report.json` plus preview artifacts under `{storyId}/print/qa/`.
4. **Workflow** (`workflows/print-generation.yaml`) now calls `POST /internal/print/quality-check` after `POST /internal/print/generate`. If critical issues remain, it then calls `POST /internal/print/quality-alert` before any customer-facing self-print notification.
5. **Storage layout**: `{storyId}/print/interior.pdf`, `{storyId}/print/cover.pdf`, matching `*_cmyk.pdf` outputs, HTML debug files, and QA artifacts under `{storyId}/print/qa/`.

### Chapter hyphenation

- Automatic hyphenation is applied only to the large-font target audiences: `children_0-2`, `children_3-6`, and `children_7-10`.
- SGW inserts discretionary soft hyphen characters into chapter HTML before Puppeteer renders the PDF. The visible `-` appears only if the browser actually breaks the line at that point.
- The current implementation lives in `src/utils/print-hyphenation.ts` and is called from `src/services/print.ts` during chapter HTML generation.
- The HTML template sets the document `lang` and enables manual hyphenation for those chapter blocks so Chromium honors the inserted soft hyphens consistently in PDF output.
- Manual overrides are supported: if editorial content already contains `&shy;`, the renderer will respect it. Language-specific exception words can also be added in `LANGUAGE_EXCEPTIONS` inside `src/utils/print-hyphenation.ts`.

### Skipping QA (`skipQA` flag)

Both `/internal/print/generate` and `/print/self-service` accept an optional `skipQA: boolean` field (default `false`).

When `skipQA` is `true`, `print-generation.yaml` skips the `qualityCheckPDF` and `notifyPrintQaAdmins` steps entirely — the workflow goes straight from PDF generation to customer notification. This is intended for bulk, low-stakes campaigns (e.g. World Book Day) where throughput matters more than QA. The flag is echoed through `SelfPrintWorkflowPayload` and stored in run metadata.

### Self-print workflow hooks

- `POST /print/self-service` receives requests from the web app, dedupes recipients (author auto-added when possible), and launches `print-generation`. Every accepted request logs `Self-print workflow enqueued` with `storyId`, `workflowId`, `executionId`, and the number of recipients to simplify refunds.
- The workflow payload contains `delivery` metadata (locale, requestedBy, etc.) so `print-generation.yaml` can call `/internal/print/self-service/notify` only after QA finishes. Customer emails therefore always reference the post-QA assets, including any accepted interior reflow fix.
- Self-print delivery is never blocked by internal QA-critical findings. If QA can safely improve the interior but still leaves unresolved critical issues, SGW still promotes the best safe PDF set, sends the normal customer self-print email unchanged, and keeps the QA-critical messaging internal/admin-only.
- `RunsService` persists `gcpWorkflowExecution` (Cloud Workflows execution id) allowing Notification Engine to echo the identifier back inside `metadata.workflowExecutionId` for observability dashboards.

### QA checks and auto-fix scope

- Deterministic checks currently cover chapter starts on odd pages, unexpected blank interior pages, sparse chapter-ending pages, cover spine policy (<60 interior pages means no spine text), HTML double spaces, inline chapter font-size overrides, and minimum 5 mm text-safe margins.
- Auto-fix v2 remains limited to sparse chapter endings, but it now escalates per chapter instead of applying one blanket profile to every sparse chapter. The QA service runs a greedy-restart search over bounded body-text-only soft/medium/strong/strong-plus/maximum override candidates: it renders one interior-only candidate at a time, accepts the first safe sparse-count reduction, records the accepted baseline signature to avoid repeated states, and then restarts from the new baseline. It never accepts candidates that introduce new critical issues, fail to reduce sparse-chapter count, or drop below the 5 mm margin floor.
- Intermediate QA attempts render only the RGB interior PDF needed for deterministic checks. Cover PDFs are reused unchanged, and CMYK work is deferred until the final accepted interior so the search does not waste time regenerating cover or CMYK assets for rejected candidates.
- If the bounded search removes every sparse-ending critical, QA returns `passed_with_fixes`. If the search safely improves some chapters but leaves others unresolved, QA still promotes the best safe partial baseline, returns `critical_issues_remaining`, keeps `fixesApplied` populated, and includes the promoted PDF URLs in `printResult`. When the original run requested CMYK output, SGW regenerates the interior CMYK file once for the final accepted interior only.
- Visual review is layered on top of the deterministic checks. QA uploads cover and chapter-opening preview PNGs, then asks Google GenAI for a JSON-only pre-press review focused on title visibility, logo/QR placement, bleed/composition, and obvious interior visual issues.
- If critical issues remain after QA, the workflow still finishes as `completed`, but run metadata is enriched with `printQaStatus`, `printQaReportUrl`, counts, applied fixes, and whether an admin alert email was sent. Customer self-print delivery still uses the promoted `qaResult.body.printResult`; the QA alert and report remain internal signals for operators.

## Configuration checklist

| Item           | Notes                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ghostscript    | Install locally or bake into Docker; point `GHOSTSCRIPT_BINARY` to `gs` (Linux) or `gswin64c.exe` (Windows).                                                                         |
| Temp directory | `TEMP_DIR` defaults to system temp. Override (e.g., `/tmp/mythoria-print`) if the container needs a dedicated mount.                                                                 |
| ICC profiles   | `npm run setup-icc-profiles` downloads CoatedFOGRA39, ISOcoated_v2_eci, etc. Production Docker builds copy files under `icc-profiles/` and reference `src/config/icc-profiles.json`. |
| Paper config   | `paper-caliper.json` defines trim size (170×240mm), bleed, safe zones, and caliper used for spine width math.                                                                        |
| Pub/Sub        | Print jobs can be triggered by webapp orders via topic `mythoria-print-requests`, which in turn calls the workflow.                                                                  |

## Page layout processing (interior)

- **Image detection:** `src/services/pdf-page-processor.ts` uses `pdf-parse@2.x` `getImage()` output to locate full-bleed chapter images (large embedded images starting at page 6 to skip front matter). No hidden `EMPTY-PAGE-MARKER` tags are required anymore. Image detection logs show which pages contain images in the original PDF.
- **Blank page removal:** Pages with no extracted text or images are dropped to avoid accidental blank spreads (including the legacy trailing blank page in the template).
- **Recto rule:** Chapters must open on an odd page. When the chapter image would land on an odd page, the processor flips the sequence so text comes first and the image moves after the chapter text. If the image is already on an even page, the existing image→text order is kept. Debug logs track both the original and final positions of image pages.
- **Outputs:** `processPages` returns the reordered page map and the final image-page numbers (after reordering) so downstream CMYK conversion can keep art in color while grayscaling text pages. The `imagePagesDetected` array contains page numbers in their **final positions after reordering**, not their original positions.

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

### Interior grayscale + color merge

- The CMYK service now renders two intermediate interiors:
  - **Grayscale/K-only:** Ghostscript conversion with `/DeviceGray` and black-preservation flags for all non-image pages.
  - **Color CMYK:** Standard CMYK conversion.
- Using the image-page list from the processor, the service recombines pages so:
  - **Chapter image pages** stay full CMYK color.
  - **All other pages** are replaced with the grayscale/K-only pages, preserving deep black text and keeping non-image spreads strictly B/W.
- Covers remain full CMYK; selective grayscale applies only to the interior.

## Testing & validation

| Intent                         | Command                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| Verify Ghostscript presence    | `pwsh -NoProfile -Command "npm run test:ghostscript"`                                       |
| Render sample PDFs & convert   | `pwsh -NoProfile -Command "npm run test:cmyk"`                                              |
| Page layout + image detection  | `npm test -- pdf-page-processor`                                                            |
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
