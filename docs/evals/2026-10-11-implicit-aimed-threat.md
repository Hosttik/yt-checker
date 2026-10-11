# Directed aiming recall + reviewer fallback diagnostics

## Reproduced from four saved Compot scans (2026-10-11)

| Run | Mandatory attention controls | Missing | Total wall | Reviewer fallback |
|---|---:|---|---:|---:|
| 09:21 | 5/5 | — | 68.4 s | 4 |
| 10:04 | 4/5 | Armed pursuit | 52.7 s | 3 |
| 10:35 | 5/5 | — | 68.5 s | 3 |
| 12:41 UTC | 4/5 | Police aiming | 53.2 s | 4 |

The last scan's transcript at ~08:00 includes the victim twice asking another character to stop aiming at them while being commanded to stand up and answer questions. The detector emitted only an earlier plastic-head fear event. Generic fear coverage cannot represent this threat.

## Change

Risk recall selects directed aiming pleas with nearby coercive commands, even without a gun noun. It sends bounded context to the **existing** detector+reviewer, never directly adds a content finding. Benign gameplay aiming and unsupported physical details are intentionally excluded from the trigger/prompt.

The batched reviewer now records `batchIncompleteReasons` in diagnostic results so its four fallback calls can be attributed to missing outer results, missing candidate decisions, invalid/moved evidence, duplicate/unknown identifiers, or defensive rejection of unsafe downgrades. This is diagnostic only: do not claim that fallback counts decreased yet.

The strict scene benchmark fails when required controls are absent from the checked video set or no saved input was provided. A rotating latest-10 selection must be replaced with a fixed-video scan for strict historical comparisons.

## Offline replay

```bash
DETECTOR_RECALL_REPLAY_ANALYSIS='/path/to/openai-analysis.json' \
DETECTOR_RECALL_REPLAY_RESULT='/path/to/result.json' \
npm run eval:detector-recall
```

Strict fixed-scene test:

```bash
SCAN_RECALL_RESULTS='/path/to/result.json' SCAN_RECALL_ENFORCE=1 npm run eval:scan-recall
```

The offline detector replay verifies whether the selector targets the formerly missed police scene and leaves the already detected armed pursuit covered; it does not call the model or certify that the model will actually return a finding.

## Next validation

Repeat a fixed 10-video channel scan several times. Check hard-scene recall, targeted request count, fallback reason distributions, review latency and token cost. Do not change batch thresholds without those reasons.
