# Detector batching stability experiment

Purpose: determine whether first-pass recall changes with detector batch composition before enabling any permanent coverage pass.

## Target regressions

The audit found identical normalized transcripts with materially different first-pass output:

- `MmdIhSW5B7Q`: 25 candidates when sent alone, 0 when grouped in a five-item detector request.
- `edgRlTMnF0o`: 1 candidate when sent alone, 0 in the same five-item request.

This correlation makes batch composition the main hypothesis to test, but does not prove causality.

## Preconditions

Use the saved scan directories that contain the normalized transcripts and set `OPENAI_API_KEY` in `.env`.

The quality eval now uses:

- the production detector/reviewer batching stack;
- the saved transcript language (for these scans, `asr-ru`);
- normal production coverage policy by default (coverage is off);
- the same batch-size/token/coalescing environment variables as production.

## Controlled comparison

Run only the two target videos first:

```bash
QUALITY_VIDEO_IDS=MmdIhSW5B7Q,edgRlTMnF0o \
QUALITY_SCAN_DIRS=scan-results/2026-10-06T15-22-40-116Z_40298a8a-178e-4d1d-85d2-aea798ec1f9c,scan-results/2026-10-06T15-25-28-310Z_ba7c44fb-580b-44ed-aab4-a6269dc01983 \
npm run eval:parental-quality:detector-batch1
```

Then repeat with production-size detector batches:

```bash
QUALITY_VIDEO_IDS=MmdIhSW5B7Q,edgRlTMnF0o \
QUALITY_SCAN_DIRS=scan-results/2026-10-06T15-22-40-116Z_40298a8a-178e-4d1d-85d2-aea798ec1f9c,scan-results/2026-10-06T15-25-28-310Z_ba7c44fb-580b-44ed-aab4-a6269dc01983 \
npm run eval:parental-quality:detector-batch5
```

For a stronger composition test, include all ten videos from the saved scan and keep `QUALITY_ORDER_MODE=rotate` (the two detector-batch scripts already set it). Every repeated run records its video order and complete batching manifest in the benchmark JSON.

## Decision rule

Do not enable coverage merely because a single retry rescues a zero result.

Treat batching as materially harmful if the same human-visible main anchors have a substantially higher first-pass miss rate with `batchMaxItems=5` than with `batchMaxItems=1`, especially when misses track order/composition.

If batch size is not the driver, compare repeated batch-1 runs. Instability there points to detector/model variance rather than cross-item interference.

Only after this comparison choose among:

1. smaller detector batches;
2. a targeted zero/low-confidence verification pass;
3. a permanent narrow high-priority coverage pass.

Any option must be evaluated together with wall-clock latency, request count and OpenAI cost; recall improvement alone is not sufficient.
