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

Use the dedicated, paid opt-in detector experiment (Node 22+):

```bash
npm run eval:detector-stability
```

It takes **five** fixed saved transcripts, restores their original timestamps, and compares batch sizes 1 and 5 in forward and reverse order. It alternates configuration order, fixes concurrency to 1, records model/prompt/schema, transcript hashes, outputs and request counts in `benchmark-results/detector-stability/`. Override the saved scan with `DETECTOR_SCAN_DIR`. Local saved artifacts and an API key are required.

The previous two-video quality-eval command was not a five-item composition test and the target videos had no gold annotations. Use the dedicated experiment for variance; use the production-stack quality eval separately for annotated end-to-end checks. Neither detector counts nor provisional annotations establish human accuracy.

## Measurement on 2026-10-06

Model `gpt-6-luna`, reasoning `low`, detector prompt v9/schema 10. Four configurations completed, 12 requests, about 115 seconds including test startup. Candidate counts in fixed video order:

| Configuration | edgRlTMnF0o | MmdIhSW5B7Q | ed7JivZ43xs | B7PGgMjJyoQ | RmGCg3FRdb8 |
|---|---:|---:|---:|---:|---:|
| Batch 1, forward | 3 | 3 | 3 | 1 | 3 |
| Batch 5, forward | 1 | 0 | 1 | 0 | 3 |
| Batch 5, reverse | 3 | 3 | 1 | 0 | 2 |
| Batch 1, reverse | 4 | 15 | 0 | 1 | 2 |

The gun-pointing scene in `edgRlTMnF0o` appeared in all four runs. The pleas for help/cessation in `MmdIhSW5B7Q` appeared in both reverse-order runs and neither forward-order run, including batch 1 with three unrelated candidates. These are inspections of detector outputs against transcript anchors, not independent human labels or final parental-warning scores. The model also swapped actor/target in a captivity scene in one output.

Conclusion: misses occur even with batch size 1 and nonempty output. Two orders do not isolate composition from sampling variability. Keep the production default unchanged pending a larger annotated comparison; neither batch size 1 nor retry-on-zero is demonstrated to solve recall. Saved raw result (local, Git-ignored): `benchmark-results/detector-stability/2026-10-06T18-22-55-602Z.json`.

## Decision rule

Do not enable coverage merely because a single retry rescues a zero result.

Treat batching as materially harmful if the same human-visible main anchors have a substantially higher first-pass miss rate with `batchMaxItems=5` than with `batchMaxItems=1`, especially when misses track order/composition.

If batch size is not the driver, compare repeated batch-1 runs. Instability there points to detector/model variance rather than cross-item interference.

Only after this comparison choose among:

1. smaller detector batches;
2. a targeted zero/low-confidence verification pass;
3. a permanent narrow high-priority coverage pass.

Any option must be evaluated together with wall-clock latency, request count and OpenAI cost; recall improvement alone is not sufficient.
