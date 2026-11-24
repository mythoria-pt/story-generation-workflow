# Print & CMYK Pipeline

SGW produces two PDF sets per story—RGB (screen) and CMYK (print-ready)—and stores them alongside other assets in Google Cloud Storage. This document merges the former implementation notes, CMYK conversion guide, and troubleshooting checklist.

## Components & flow

1. **Print service** (`src/services/print.ts`) renders HTML templates into `interior.pdf` and `cover.pdf` via Puppeteer using trim-size + paper-caliper data from `src/config/paper-caliper.json`. It now inserts soft hyphen opportunities into large-font chapter HTML (`children_0-2`, `children_3-6`, `children_7-10`) before rendering so justified child-reader layouts can break long words cleanly. It post-processes the interior PDF to enforce page ordering rules (see below) before any color work happens.
2. **CMYK conversion service** (`src/services/cmyk-conversion.ts`) calls Ghostscript to convert each RGB PDF to CMYK (`*-cmyk.pdf`). Interior generation now creates a grayscale-only copy for text pages and merges it with full-CMYK image pages so non-art pages stay K-only.
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

- `POST /print/self-service` receives requests from the web app, dedupes recipients (author auto-added when possible), reserves the supplied workflow ID, and launches `print-generation` only once.
- The workflow payload contains `delivery` metadata (locale, requestedBy, etc.) so `print-generation.yaml` can call `/internal/print/self-service/notify` only after QA finishes. Customer emails use the generated assets or the set promoted by QA, including any accepted interior reflow fix.
- Generated PDFs remain deliverable after critical QA findings, an internal QA failure, a QA timeout, or an instance termination. QA reports `review_failed` when it cannot complete. The workflow uses the generated PDFs if QA returns no result, and calls the operational alert endpoint with a synthetic finding.
- `RunsService` persists `gcpWorkflowExecution` (Cloud Workflows execution id) allowing Notification Engine to echo the identifier back inside `metadata.workflowExecutionId` for observability dashboards.

### QA checks and auto-fix scope

- Deterministic checks currently cover chapter starts on odd pages, unexpected blank interior pages, sparse chapter-ending pages, cover spine policy (<60 interior pages means no spine text), HTML double spaces, inline chapter font-size overrides, and minimum 5 mm text-safe margins.
- Auto-fix v2 remains limited to sparse chapter endings, but it now escalates per chapter instead of applying one blanket profile to every sparse chapter. The QA service runs a greedy-restart search over bounded body-text-only soft/medium/strong/strong-plus/maximum override candidates: it renders one interior-only candidate at a time, accepts the first safe sparse-count reduction, records the accepted baseline signature to avoid repeated states, and then restarts from the new baseline. It never accepts candidates that introduce new critical issues, fail to reduce sparse-chapter count, or drop below the 5 mm margin floor.
- Intermediate QA attempts render only the RGB interior PDF needed for deterministic checks. Cover PDFs are reused unchanged, and CMYK work is deferred until the final accepted interior so the search does not waste time regenerating cover or CMYK assets for rejected candidates.
- If the bounded search removes every sparse-ending critical, QA returns `passed_with_fixes`. If the search safely improves some chapters but leaves others unresolved, QA still promotes the best safe partial baseline, returns `critical_issues_remaining`, keeps `fixesApplied` populated, and includes the promoted PDF URLs in `printResult`. When the original run requested CMYK output, SGW regenerates the interior CMYK file once for the final accepted interior only.
- Visual review is layered on top of the deterministic checks. QA uploads cover and chapter-opening preview PNGs, then asks Google GenAI for a JSON-only pre-press review focused on title visibility, logo/QR placement, bleed/composition, and obvious interior visual issues.
- The workflow records the PDFs and QA outcome on the completed run before customer email. Run metadata includes `printQaStatus`, `printQaReportUrl`, counts, applied fixes, `printQaAlertSent`, and `printQaAlertFailureReason`.

### Delivery and alert outcomes

- `printDeliveryStatus` starts as `pending` for customer delivery and `not_requested` for direct generation. The workflow persists `sent` after an explicit Notification Engine sent result, `accepted` while the engine reports pending or sending, `failed` after an explicit failure, and `unknown` when confirmation is unavailable. Provider completion is separate from PDF completion.
- The QA alert sends the run ID as the legacy entity ID and uses the stable `Idempotency-Key: print-qa-critical:<runId>`. The deployed legacy Notification Engine reports per-recipient outcomes and can return HTTP 200 for a partial send. The workflow retries only a confirmed manager lookup failure, which happens before dispatch. It records partial, accepted and unknown delivery separately from confirmed sends, and a lost response does not trigger a resend. This path also accepts explicit delivery status from a ledger-enabled engine.
- Manager lookup and notification dispatch failures return structured reasons. After the final unsuccessful alert attempt, the workflow logs an ERROR with event `print_qa_alert_delivery_failed`, story and run IDs, QA status and reason. This also covers a successful manager lookup with an empty recipient list.

### Memory profiling

During generation, the worker renders the interior and cover serially, converts them in sequence and uploads one PDF buffer at a time. It removes the per-run working directory on exit. QA keeps only the active candidate files and cleans its own working directory on exit.

Filter SGW logs for `event=print_memory_sample` and the run ID to compare generation, PDF upload, QA downloads, deterministic checks, reflow, visual review and completion. Node fields are bytes. Linux cgroup v2 fields expose current usage, instance peak, limit and memory events when available. Peak values cover the lifetime of the process or cgroup, so compare neighboring samples and correlate with Cloud Run memory termination logs. Application code cannot log a final snapshot after the instance is killed.

A local Node 24.18.1 macOS probe used a 24-page synthetic PDF with twelve 1,536×2,048 JPEG images alternating with text pages. The image extraction and resource scan found the same twelve pages. Stage results are independent runs.

| Stage                                             |                           Measured peak |
| ------------------------------------------------- | --------------------------------------: |
| PDF.js text extraction                            |                        193 MiB Node RSS |
| PDF.js image discovery with image output disabled |                        630 MiB Node RSS |
| XObject resource inspection                       |                        157 MiB Node RSS |
| Six 1,200-pixel visual previews                   |                        434 MiB Node RSS |
| Ghostscript full-CMYK conversion                  | 197 MiB summed Node and Ghostscript RSS |
| Chromium interior and cover rendering in parallel |  1,635 MiB summed Node and Chromium RSS |
| Chromium interior and cover rendering serially    |  1,111 MiB summed Node and Chromium RSS |

The Chromium comparison used four synthetic 1,536×2,048 illustrations and a separate single-image cover. Process-tree sampling ran every 50 ms. Summed RSS can count shared pages more than once. macOS has no Linux cgroup accounting, so these measurements do not establish a Cloud Run memory limit or reproduce an instance-level OOM.

## Configuration checklist

| Item           | Notes                                                                                                                             |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Ghostscript    | Install locally or bake into Docker; point `GHOSTSCRIPT_BINARY` to `gs` (Linux) or `gswin64c.exe` (Windows).                      |
| Temp directory | `TEMP_DIR` defaults to system temp. Override (e.g., `/tmp/mythoria-print`) if the container needs a dedicated mount.              |
| ICC profiles   | The Docker build copies the checked-in `icc-profiles/` directory. `src/config/icc-profiles.json` maps profile names to filenames. |
| Paper config   | `paper-caliper.json` defines trim size (170×240mm), bleed, safe zones, and caliper used for spine width math.                     |
| Pub/Sub        | Print jobs can be triggered by webapp orders via topic `mythoria-print-requests`, which in turn calls the workflow.               |

## Page layout processing (interior)

- **Image detection:** Generation and deterministic QA inspect image XObject resources in the PDFs generated by Chromium, including images inside forms. This finds illustrated pages without decoding or rasterizing their pixels. Page reordering ignores front matter.
- **Recto rule:** Chapters must open on an odd page. When the chapter image would land on an odd page, the processor flips the sequence so text comes first and the image moves after the chapter text. If the image is already on an even page, the existing image→text order is kept. Debug logs track both the original and final positions of image pages.
- **Outputs:** `processPages` returns the reordered page map and the final image-page numbers (after reordering) so downstream CMYK conversion can keep art in color while grayscaling text pages. The `imagePagesDetected` array contains page numbers in their **final positions after reordering**, not their original positions.

## CMYK conversion specifics

- The cover and color interior pages select `PSOCoatedNPscreen` by default. The converter passes the corresponding `PSO_Coated_NPscreen_ISO12647_eci.icc` to Ghostscript as `-sDefaultCMYKProfile`.
- If the selected file is missing or detected as a placeholder, conversion uses Ghostscript’s built-in CMYK handling and logs `Using built-in CMYK conversion (no ICC profile)`.
- The current Ghostscript invocation writes PDF 1.4 and does not configure PDF/X mode or a catalog output intent. Verify a printer’s PDF/X and output-intent requirements before using these files.
- If CMYK conversion throws during print-set generation, the service logs `CMYK conversion failed, continuing with RGB only` and retains the RGB PDFs.

### Interior grayscale + color merge

- The CMYK service now renders two intermediate interiors:
  - **Grayscale/K-only:** Ghostscript conversion with `/DeviceGray` and black-preservation flags for all non-image pages.
  - **Color CMYK:** Standard CMYK conversion.
- Using the image-page list from the processor, the service recombines pages so:
  - **Chapter image pages** stay full CMYK color.
  - **All other pages** are replaced with the grayscale/K-only pages, preserving deep black text and keeping non-image spreads strictly B/W.
- Covers remain full CMYK; selective grayscale applies only to the interior.

## Testing & validation

| Intent                                    | Command                                                      |
| ----------------------------------------- | ------------------------------------------------------------ |
| Verify Ghostscript presence               | `gs --version` or `gswin64c.exe --version` on Windows        |
| Run print-quality and page layout tests   | `npm test -- --runInBand print-quality pdf-page-processor`   |
| Check the selected ICC profile is bundled | Compare `icc-profiles/` with `src/config/icc-profiles.json`. |

Run print API smoke tests with synthetic PDFs and isolated database and storage configuration. The print generation route writes job state and uploads assets.

### Deployment tips

- Allocate **2 vCPU / 2–4 GiB RAM** on Cloud Run; CMYK conversion peaks around ~500 MB per PDF.
- Set request timeout ≥900 s; large interiors need time for Puppeteer + Ghostscript.
- The Docker build installs Ghostscript and copies the checked-in ICC profiles into the image.

## Troubleshooting

| Symptom                                      | Likely cause                                                        | Fix                                                                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `Command failed: gswin64c.exe ...`           | Ghostscript missing, wrong path, or placeholder ICC treated as real | Install Ghostscript, update `GHOSTSCRIPT_BINARY`, and confirm the configured ICC profile is present and larger than 100 KB. |
| `Using built-in CMYK conversion` log in prod | ICC not bundled into image                                          | Ensure Docker build copies `icc-profiles/` and `src/config/icc-profiles.json` points to valid filenames.                    |
| Temp-file permission errors                  | `TEMP_DIR` unwritable inside container                              | Set `TEMP_DIR=/tmp/mythoria-print` and ensure the Cloud Run service account can write there.                                |
| Cover alignment issues                       | Paper caliper or trim settings mismatched to provider spec          | Adjust `src/config/paper-caliper.json` and redeploy; confirm bleed = 3 mm and safe zone 10 mm per current assumptions.      |

## Reference outputs

Each successful run uploads:

- `interior.pdf` / `cover.pdf` – RGB reference versions for web preview.
- `interior-cmyk.pdf` / `cover-cmyk.pdf` – CMYK variants when conversion succeeds.
- `interior.html` / `cover.html` – Debug HTML snapshots.

Review artifacts in Cloud Storage before shipping to printers, especially after updating templates or caliper data.
