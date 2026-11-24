# Premium illustrated books

The story workflow resolves the saved book type after claiming the run. Premium work requires a matching accepted request, author, eligible audience and queued revision. The Web App checks the experimental preference when accepting the request. The worker resumes accepted work from the same run and frozen inputs. The Pub/Sub book type, when present, must agree with the story marker.

## Configuration

Set `PREMIUM_BOOK_BUCKET` to the dedicated private bucket shared with the Web App. Use uniform bucket-level access and enforce public access prevention. The SGW service account needs to read the bucket configuration and IAM policy and to create, read and remove its own objects. The Web App needs to read objects by storage generation. Keep older published objects available for pinned paid print orders. The SGW service account also needs permission to launch and inspect the existing `mythoria-story-generation` workflow for operator recovery.

| Variable                    | Default                  |
| --------------------------- | ------------------------ |
| `PREMIUM_IMAGE_PROVIDER`    | `openai`                 |
| `PREMIUM_IMAGE_MODEL`       | `gpt-image-2.6-sunburst` |
| `PREMIUM_IMAGE_QUALITY`     | `high`                   |
| `PREMIUM_IMAGE_SPREAD_SIZE` | `3840x1952`              |
| `PREMIUM_IMAGE_SQUARE_SIZE` | `1536x1536`              |

The text provider uses the configured story text model for the storyboard and a visual review of each generated illustration. Premium image usage records the measured provider input and output tokens and the stage latency. Story content and references stay out of these records. Sunburst price estimation uses reported text and image token counts at the published rates. The account invoice remains the record of actual billing. [OpenAI model pricing](https://developers.openai.com/api/docs/models/gpt-image-2.6-sunburst)

## Book and storage contract

The [storyboard prompt and editorial guidance](premium-storyboard-prompt.md) explain how the generator selects text placement and show examples from both age groups.

New storyboards select `openingDesign.motif` and `openingDesign.background` once. The published manifest freezes both. Keep the opening-design registry in sync with the Web App and preserve existing motif paths and colours for previously published books. The title and dedication use the selected line drawing, and all four opening pages use the selected pastel. Historical checkpoints and manifests without this field retain their original design.

New 33-page books also request one small transparent ornament based on a recurring object and the spread that shows it. The publisher pins an accepted PNG as `motifArtwork` and uses those same bytes on pages 1 and 3. Missing or rejected output uses the selected curated drawing. A durable attempt receipt prevents a duplicate provider call if the workflow loses the response. A concurrent publisher retries while an active attempt is choosing the ornament.

- `stories.features.premiumBook` holds `version: 1`, `type: premium_children` and state `draft`, `queued` or `published`. Queued and published markers carry the revision UUID, owner and eligible audience. The initial revision is the accepted workflow run ID. A published marker also carries the manifest key, storage generation, SHA-256 and byte count.
- `{storyId}/premium/revisions/{revision}/manifest.json` records the immutable edition. Its assets live in story-scoped revision directories with content-addressed names. Canonical text is rendered separately in the reader and print PDF. Pages 1–4 contain the localized opening information and dedication, page 5 is the opener, pages 6–31 form thirteen facing spreads and page 32 is the narrative ending.
- New editions add the localized publisher invitation on page 33. Its text and link to the localized Mythoria story creator come from the generator and are frozen with the accepted input. Earlier 32-page editions and in-progress runs without the invitation in their frozen input keep their original page plan, including when staff correct a spread.
- Each spread can use `both_pages` or `right_only`. An omitted layout means `both_pages`. Ages 0–2 favour a brief spoken phrase and repetition. Ages 3–6 can use both pages for a short sequence or dialogue and a silent left page for a reveal. The storyboard adapts phrasing to the book's language and the space available at the normal type size. A silent left page has both artwork derivatives and an empty canonical text field.
- Each spread starts with a single continuous painting. The centre-line check and visual review reject visible joins, unsuitable placements, lettering and inconsistent artwork. An illustration retry covers the whole spread. Text and visual checks run before the story pointer is published.
- Digital captures use a common 96-PPI grid and lossless PNG. The two trims rejoin without additional resampling. Print captures use a 304-PPI grid with 38 bleed pixels on each edge. Adjacent pages overlap by 76 pixels in the bleed and meet at the centre of the visible trim. The private manifest retains native dimensions and effective PPI separately from the export grid.
- A completed stage writes an immutable checkpoint. A per-stage storage lease prevents duplicate provider work during overlapping retries, and a later execution can recover an expired lease. Each checkpoint binds to the frozen input and configured models. Publication verifies the full asset set before changing the story pointer with a row lock and expected revision.

## Operator recovery and correction

Call `POST /internal/premium/runs/{runId}/resume` with `{ "storyId": "…" }` through authenticated SGW access. It resumes an eligible failed or blocked run, or a run whose recorded Workflows execution has failed. Active work returns its current run identity. Concurrent retry calls converge at the workflow claim, which checks the same prior status and update timestamp. The original acceptance, debit, revision and validated checkpoints are retained.

Call `POST /internal/premium/stories/{storyId}/corrections` with the current `expectedRevision`, a new UUID `correctionId` and one `spreadId` (such as `spread-3`). Provide `leftText`, `rightText` or `artworkInstructions` as needed. To switch a pair to `right_only`, explicitly provide that layout, empty `leftText` and the new `rightText`. To restore `both_pages`, provide the new left line. Exact text-only corrections reuse all existing artwork. Artwork corrections generate and verify a new master and both derivatives. The request may be retried with the same body and correction ID. A stale expected revision must be reviewed before another attempt. The returned revision includes `previousRevision` in its manifest so staff can explicitly rebind a held paid order through the existing revise-proof workflow.
