# Image preprocessing: crop-to-content and long-receipt handling

Date: 2026-08-02 · Layer: **L1 NORMALISE** (see `2026-08-02-app-layers.md` §1)
Companion docs: `2026-08-02-on-device-ai-stack.md`, `2026-08-02-app-layers.md`, `data-layer/03-schema.md`

**Status legend.** **[VERIFIED]** = read from the primary source. **[REPORTED]** = secondary source. **[INFERRED]** = reasoning from the above, no direct source. **[TUNE]** = a starting value that must be calibrated against the eval corpus, not a measured constant.

---

## 0. Why this is load-bearing, not polish

A small on-device VLM does not see pixels. It sees a fixed budget of visual tokens spread across whatever image you hand it. Everything in this document follows from that one fact.

Gemma 4's visual token budget is configurable, and the supported values are **70, 140, 280, 560, 1120**. Google's own guidance: use **560–1120 for OCR, document parsing, or reading small text**, and lower budgets only for classification or captioning. Images can be processed at variable aspect ratios and resolutions, and **image content must be placed before the text in the prompt**. [VERIFIED — Gemma 4 model card, ai.google.dev]

Two consequences the rest of the pipeline has to respect:

**A receipt that fills 40% of the frame wastes 60% of the budget encoding carpet.** The budget is spent on the whole image, not on the interesting part of it. Cropping to content is not a cosmetic improvement — it is a direct multiplier on effective resolution over the only region that matters.

**A tall receipt spreads the same budget over a long strip.** A 1:8 thermal receipt at the 1120-token maximum has far fewer tokens per character than a 1:1.4 A4 receipt at the same budget. Digits are the first thing to go, and digits are exactly the two fields a finance app cannot get wrong — amount and date. This is the same failure class as the reported Metal digit-corruption issue in `app-layers.md` §3, arriving through a different door.

The honest framing: **this document is mostly about not wasting a budget you cannot increase.**

---

## 1. The pipeline

```text
  camera / share / screenshot
            │
            ▼
  ┌─ 1. CAPTURE ──────────────────────────────────────────────┐
  │  document scanner (VisionKit / ML Kit) — quad + dewarp     │
  │  falls back to a plain still when detection declines       │
  └───────────────────────┬────────────────────────────────────┘
                          ▼
  ┌─ 2. CROP TO CONTENT ──────────────────────────────────────┐
  │  T1 scanner quad → T2 OCR text-box union → T3 full frame   │
  └───────────────────────┬────────────────────────────────────┘
                          ▼
  ┌─ 3. QUALITY GATE ─────────────────────────────────────────┐
  │  blur · glare · median glyph height in px                  │
  │  fail ⇒ ask for a re-shoot BEFORE spending model time      │
  └───────────────────────┬────────────────────────────────────┘
                          ▼
  ┌─ 4. SEGMENT IF LONG ──────────────────────────────────────┐
  │  aspect > threshold ⇒ split at whitespace, with overlap    │
  └───────────────────────┬────────────────────────────────────┘
                          ▼
  ┌─ 5. RESOLUTION POLICY ────────────────────────────────────┐
  │  token budget 1120 · per-segment aspect near square        │
  └───────────────────────┬────────────────────────────────────┘
                          ▼
              L2 EXTRACT (OCR+LLM default, VLM escalation)
```

Every stage is skippable and every stage records what it did. A capture that fails stage 3 is still persisted — it is never discarded (`data-layer/04-capture.md`: never lose a capture).

---

## 2. Crop to content — three tiers, in order

### T1 — the document scanner quad

`VNDocumentCameraViewController` (iOS) and ML Kit Document Scanner (Android) already return edge detection, perspective correction, and dewarping. [VERIFIED — see `on-device-ai-stack.md` §4] Use it whenever it succeeds; it is free and better than anything hand-rolled.

**It will decline more often than you expect on receipts.** Document scanners are tuned for rectangular pages on contrasting backgrounds. A crumpled thermal receipt, a torn edge, a receipt on a wood-grain table, or one photographed at 1:10 aspect are all cases where detection returns nothing or returns a bad quad. [INFERRED — from the design intent of those APIs; **measure this rate on the eval corpus, it drives everything below**]

So T1 is the happy path, not the plan.

### T2 — the OCR text-box union (the one that does the work)

**The default extraction path already runs OCR before the LLM.** OCR returns per-line bounding boxes. The union of those boxes, expanded by a margin, *is* the content region.

**A naive union is wrong, and the error is easy to miss.** Taking the union of *all* OCR line boxes includes any text that happens to be in frame — a magazine on the table, another receipt, a laptop screen. Those boxes are high-confidence, so confidence filtering does not remove them, and the union grows to enclose them **by construction**. The crop would then be larger than the frame-fill it was meant to fix, and the background text stays.

Cluster first, then union:

```
lines   = ocr(image).lines filtered to confidence > MIN_LINE_CONF     # [TUNE] 0.30
if lines.count < MIN_LINES:  return T3                                # [TUNE] 3

# Group lines into candidate documents. A receipt is a run of lines that are
# vertically close and share horizontal extent; a magazine across the table is not.
clusters = connectedComponents(lines, adjacentIf: { a, b in
    verticalGap(a, b) < 1.5 * medianLineHeight            # [TUNE]
      && horizontalOverlap(a, b) > 0.35                   # [TUNE]
})
doc     = clusters.maxBy { $0.totalTextArea }             # dominant cluster wins
if let quad = scannerQuad { doc = doc.filter { quad.contains($0.center) } }  # T1 ∩ T2

box     = unionOf(doc.map(.boundingBox))
box     = box.expanded(by: 0.04 * max(box.w, box.h))      # [TUNE] 4% margin
box     = box.clamped(to: imageBounds)
if box.area / imageBounds.area > 0.92: return uncropped   # nothing to gain
return crop(image, box)
```

When T1 produced a quad, intersecting with it is the cheapest and most reliable disambiguator — the scanner already decided where the document is, and T2 only needs to tighten it.

Why this is the right primary mechanism:

- **It costs nothing.** The OCR pass runs anyway. No second model, no extra download, no extra latency beyond a crop.
- **It is deterministic and debuggable.** A wrong crop is inspectable as a set of boxes, not a black-box saliency map.
- **It degrades honestly.** No text found means no crop, which is the correct answer.
- **It is cross-platform by construction** — it consumes OCR output, so it works identically over Apple Vision, ML Kit, or the ExecuTorch EasyOCR port.

Rejected alternative: saliency or subject segmentation (`VNGenerateAttentionBasedSaliencyImageRequest`, ML Kit Subject Segmentation). They target photographic subjects, not documents, and they add a model and a platform divergence to solve a problem the OCR boxes already solve. [INFERRED]

Rejected alternative: OpenCV contour detection. It means vendoring OpenCV into a project that already has a heavy native surface, to reimplement what the document scanner does better when it works and what the OCR union does better when it does not. [INFERRED]

### T3 — no crop

Full frame, `crop_method = 'none'`, and the extraction is flagged lower confidence. Never block on a failed crop.

### Ordering note

Run T1 **at capture time** so the user gets the familiar scanner UI and a corrected image. Run T2 **after OCR**, on whatever T1 produced — they compose. A scanner-corrected image with a wide white border still benefits from the OCR union crop.

---

## 3. Long receipts — segment, do not squash

### The trigger

```
aspect = longEdge / shortEdge
if aspect > ASPECT_SPLIT_THRESHOLD:  segment()     # [TUNE] start at 2.5
```

[TUNE] 2.5 is a starting point chosen so that a typical A4/letter receipt (~1.4) and a half-page receipt (~2.0) pass through whole, while genuine till rolls segment. Calibrate against the eval corpus by measuring digit accuracy versus aspect ratio — that curve tells you the real threshold.

### Where to split

**Never split through a line of text.** Splitting mid-glyph produces two half-characters that both extract wrong, and the merge step cannot tell that it happened.

**Deskew first.** Horizontal cuts assume horizontal text lines. On a receipt T1 declined — which is exactly the tilted, crumpled case that reaches T2 — the whitespace gaps between lines shrink or vanish as skew increases, and the cut lands mid-text anyway. Rotate by the median OCR baseline angle before computing gaps. The angle is already available from the line boxes, so this costs one rotation.

Use the OCR line boxes from stage 2 — they are already computed:

```
gaps = verticalGapsBetween(sortedLineBoxes)         # whitespace runs
targets = evenlySpacedCuts(imageHeight, segmentCount)
cuts = targets.map { t in gaps.minBy { abs($0.center - t) } }   # snap to nearest gap
segments = cuts.pairwise().map { crop(image, from: $0.start - OVERLAP, to: $1.end + OVERLAP) }
```

`OVERLAP` is expressed in **text lines, not pixels** — carry 2 full lines into each neighbour. [TUNE] Pixel overlap breaks on receipts with varying font sizes; line overlap does not.

`segmentCount = ceil(aspect / TARGET_ASPECT)` with [TUNE] `TARGET_ASPECT ≈ 1.5`, so each segment lands near the shape the token budget is most efficient over.

### Merging results

Each segment is extracted independently and the results are merged:

- **Line items** — concatenate in segment order, then de-duplicate over the overlap regions by (normalized text, amount). The 2-line overlap guarantees a duplicate rather than a gap; a duplicate is recoverable, a gap is not.
- **Totals, merchant, date** — these appear once, usually in the first or last segment. Take the highest-confidence single value across segments rather than the first one found, and **record disagreement** — two segments claiming different totals is a strong signal to route to user confirmation.
- **Arithmetic check** — line items summing to the stated total is the cheapest correctness signal available, and after segmentation it is also a segmentation-correctness signal. A mismatch means either a real receipt discrepancy or a dropped segment. The schema already models this softly as `line_items_delta_minor` + `needs_review` rather than a hard CHECK (`data-layer/03-schema.md` §3.22) — that decision is exactly right here.

### Why not just downscale

Because the failure is not "the model sees a blurry receipt", it is "the model confidently reads 1234 as 1284". Downscaling a long receipt trades a visible failure for a silent one, in the fields where silence is most expensive.

---

## 4. Resolution and token-budget policy

| Situation | Token budget | Rationale |
| --- | --- | --- |
| Receipt extraction, VLM path | **1120** | Google's own guidance for OCR and document parsing; this is the maximum [VERIFIED] |
| Re-extraction after a model upgrade, batch/backfill | 560 | Half the cost; acceptable when the result is being compared, not trusted outright [INFERRED] |
| Screenshot of a bank push notification | 280–560 | Large system font, few fields, high contrast [INFERRED] |
| Any non-document image classification | 70–140 | Not a use case in this app today |

Feed each segment at 1120 rather than the whole strip at 1120. The budget is per image, so segmentation is what actually buys resolution — the budget setting alone cannot.

**This rests on an assumption V16 must settle: is the budget per image or per conversation?** If it is per *conversation*, then feeding four segments at 1120 each does not give four times the tokens — it divides one budget four ways, and segmentation becomes actively harmful rather than merely unnecessary. Measure this before building the segmenter; it is the same experiment as §11 item 3 and should be answered in the same sitting.

---

## 5. Quality gates — the highest-value part of this document

Run these **after crop, before the model**. Every one converts a silent wrong extraction into an actionable prompt, which is worth far more than a marginal accuracy gain.

| Gate | Method | Action on fail |
| --- | --- | --- |
| **Median glyph height** | median height of OCR line boxes in the cropped image, in px | Below [TUNE] ~14 px, ask for a closer re-shoot. This is the single best predictor of digit errors [INFERRED] |
| **Blur** | variance of the Laplacian over the cropped region | Below threshold [TUNE], offer re-shoot |
| **Glare / clipping** | fraction of pixels at or near saturation inside the crop | Above [TUNE] ~15%, warn — thermal paper under direct light loses whole lines |
| **Crop plausibility** | crop area as a fraction of frame; line count | Degenerate crop ⇒ fall back to T3 rather than cropping to noise |

The re-shoot prompt must be **specific** — "move closer, the text is too small to read reliably" beats "poor image quality". The user is standing at the till and can fix it in three seconds if told what is wrong.

All gates are advisory, never blocking: the capture is persisted regardless, and the user can always force extraction anyway.

---

## 6. Originals are never destroyed

Crops and segments are **derived artifacts**. The original stays until the user explicitly frees space.

This matters for more than sentiment: when the model is upgraded, or the crop thresholds are retuned, or a bank changes its receipt layout, the pipeline re-derives from originals. Re-deriving from a crop bakes in yesterday's cropping bug permanently.

The schema already anticipates this — `media_assets.original_deleted_at` exists for the "free up space" flow, and the extraction record survives the file (`data-layer/03-schema.md` §3.10).

---

## 7. Schema delta — APPLIED 2026-08-02

`media_assets` as written modelled thumbnails but not the crop/segment lineage this pipeline produces.

**Status: applied** to `data-layer/03-schema.md` §3.10 during reconciliation, in the final form below rather than as `ALTER TABLE` statements — the schema has not shipped, so the columns are in the `CREATE TABLE` directly. `thumbnail_of` was **generalized to `derived_from`**, since a thumbnail is just one derivation and crops/segments want the identical `ON DELETE CASCADE`. Four `CHECK` constraints were added to keep the lineage columns meaningful only together, plus two partial indexes (`ix_media_derived`, `ix_media_crop_method`).

The originally requested delta, kept for the record:

```sql
-- 1. kind: add the derived receipt artifacts
--    'receipt_crop'    — content-cropped whole receipt
--    'receipt_segment' — one band of a segmented long receipt

-- 2. generalize the lineage column: thumbnail_of -> derived_from
--    (thumbnail is then just one derivation_kind, and crops/segments reuse the
--     existing ON DELETE CASCADE, which is already the behaviour we want:
--     delete the original, the derived artifacts go with it)
ALTER TABLE media_assets ADD COLUMN derivation_kind TEXT
  CHECK (derivation_kind IN ('thumbnail','content_crop','segment'));

-- 3. geometry, so a derived artifact can be located in its parent and a
--    bad crop can be diagnosed after the fact without re-running anything
ALTER TABLE media_assets ADD COLUMN src_x INTEGER;
ALTER TABLE media_assets ADD COLUMN src_y INTEGER;
ALTER TABLE media_assets ADD COLUMN src_w INTEGER;
ALTER TABLE media_assets ADD COLUMN src_h INTEGER;
ALTER TABLE media_assets ADD COLUMN segment_index INTEGER;   -- NULL unless 'segment'
ALTER TABLE media_assets ADD COLUMN segment_count INTEGER;

-- 4. how the crop was obtained, for measuring T1 vs T2 vs T3 rates in the field
ALTER TABLE media_assets ADD COLUMN crop_method TEXT
  CHECK (crop_method IN ('scanner_quad','ocr_union','none'));
```

`crop_method` is not bookkeeping. It is the metric that tells you whether the document scanner is earning its place on your users' actual receipts, and it belongs in the local metrics ledger (`app-layers.md` §9.1).

---

## 8. Where this runs

**Native, not JS.** `app-layers.md` §2.2 already forbids image bytes crossing the JS bridge, and this pipeline is exactly why: a 12 MP receipt, a crop, and four segments moving through JSI as base64 is how a team discovers a 200 MB transient allocation in month four.

JS orchestrates by passing file paths and receiving file paths plus metadata. The crop, segment, encode, and gate computations happen in the Nitro module alongside inference, using platform imaging (Core Image / `CGImage`, Android `Bitmap` / RenderScript-replacement APIs).

Encode target: JPEG quality [TUNE] 0.80 at [TUNE] 2048 px long edge per segment, matching the capture-side policy already in `data-layer/04-capture.md`.

---

## 9. How this interacts with the locked decisions

| Path | Effect of this work |
| --- | --- |
| **OCR + text LLM (default)** | Moderate. OCR engines are resolution-tolerant and tile internally. Cropping still helps by removing background text — a magazine on the table beside the receipt is a real source of phantom line items. |
| **VLM escalation (hard receipts)** | **Essential.** This is where the token budget binds, and without segmentation a long receipt escalated to the VLM can be *worse* than the OCR path it escalated from. |
| **Apple Foundation Models (iOS contingency)** | Unaffected — it consumes OCR text, not images. Cropping helps only via cleaner OCR. |
| **VLM escalation trigger** (`app-layers.md` §8.5) | **Needs a new input.** Escalating a long receipt to the VLM without segmenting first is a downgrade. The trigger must require `aspect <= threshold OR segmentation succeeded`. |

That last row is a real change to the escalation policy and should be carried into `app-layers.md` §8.5 during reconciliation.

---

## 10. Deferred

- **Multi-shot stitching** for receipts too long for one frame. Real need (a metre-long supermarket till roll), but it needs overlap detection and alignment across separate photos — meaningfully harder than segmenting one image. v1.1. The `segment_index` / `segment_count` columns above are shaped so stitched captures fit the same model without another migration.
- **Learned per-merchant crop hints.** Once `crop_method` and correction data exist, a merchant whose receipts always fail T1 could get a tuned default. Needs field data first.

---

## 11. Verify at build time

1. **T1 decline rate on real receipts.** If the document scanner declines on most thermal receipts, T2 is not a fallback, it is the primary path — and it should be built and tested first. Measure before assuming.
2. **The aspect-versus-accuracy curve** on the eval corpus. This sets `ASPECT_SPLIT_THRESHOLD` and `TARGET_ASPECT` with evidence instead of the [TUNE] guesses above.
3. **Whether Gemma 4 already tiles internally.** The model card documents variable aspect ratio and resolution support but not the mechanism [VERIFIED that it is undocumented]. If the implementation already tiles sensibly for tall images, manual segmentation may be redundant or even harmful. **Test a long receipt whole at 1120 against the same receipt segmented, and compare digit accuracy.** This is a half-day experiment that could delete §3 entirely — run it before building segmentation.
4. **Median-glyph-height threshold** against measured digit error rate.
5. Whether the platform document scanners expose the detected quad when they *decline* to auto-capture — a low-confidence quad may still beat the OCR union.

Item 3 is the one to run first. It is cheap, and it determines whether the most complex part of this document needs to exist.
