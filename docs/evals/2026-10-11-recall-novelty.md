# Recall novelty and fixed-scene checks — 2026-10-11

Three Compot scans took 68.403s, 52.699s and 68.516s. The later two share identical normalized transcripts but differ on the armed pursuit at 09:38.

## Fixed defects

- Coverage lookup considers a bounded, danger-specific story interval as well as citations.
- Already represented rescue candidates are discarded before contextual review. New observed attacks are preserved.
- Diagnostics distinguish proposed, duplicate, and novel events.
- Fictional accidental property-only peril does not become high automatically.
- Reviewer fallback calls run with bounded concurrency via the existing scheduler.

## Offline benchmark

Run `SCAN_RECALL_RESULTS='/scan-a/result.json;/scan-b/result.json' npm run eval:scan-recall`.
To fail when a fixed control is missing, add `SCAN_RECALL_ENFORCE=1`.
The small hand-labelled control set is provisional and cannot certify global precision or recall.

## Next validation

Repeat a fixed ten-video scan multiple times and compare novel rescue yield, warning quality, cost, and P50/P95 wall time. Evaluate other channel types before expanding the safety taxonomy.
