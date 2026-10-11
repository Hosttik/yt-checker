# Detector recall and copy grounding — 2026-10-11

## Evidence (two saved Compot scans)

- 09:21: 10 videos, 68.4 s, 18 events, 14 OpenAI requests.
- 10:04: 10 videos, 52.7 s, 13 events, 9 OpenAI requests.
- Nine videos share byte-identical normalized transcripts. A directed armed pursuit around 09:38 in `_xR7fZ24O4g` was found in the first scan and omitted by the second detector, *before* contextual review.
- The second scan also demonstrated an overaggressive lexical guard: a correct summary of a police aiming threat was converted into an ugly truncated ASR quote.

## Changes

1. Add `server/domain/detector-risk-recall.ts`: a very narrow **deterministic cue selector** for apparent directed weapon danger and restrained people near rails/trains. Its output is not a detected event and is never exposed as a content warning.
2. `BatchedOpenAIAnalyzer` runs a bounded, separate **targeted detector batch** for the highest-priority uncovered cue window from a video, up to five windows per coalesced flush by default. It uses the same classification schema, same API scheduler/rate limits, and existing contextual reviewer/validation/policy.
3. Rescue failures keep primary detections and mark the review as partially verified, rather than certifying a video clean.
4. `openaiRequests.detectorRiskRecallRequests` and per-video diagnostic `analysis.riskRecall` expose cost and outcome.
5. Replace the generic copy lexical-overlap guard with a narrow check for some clear inverted negative statements. Well-formed paraphrases are preserved; on detection, a short local quote is shown, not the first 190 characters of the transcript.
6. Include a human-curated regression for the previously omitted armed-pursuit clip, plus a faithful paraphrase of the police encounter.

**This is a bounded recall mitigation, not deterministic LLM output, complete safety coverage or proof of improved recall on live scans.** The targeted pass may still return no events, and its provider calls can increase scan latency. We deliberately avoid automatic reportable events from regex matches.

### Configuration

- `OPENAI_DETECTOR_RISK_RECALL_ENABLED=false` disables the targeted pass (enabled by default when batching is on).
- `OPENAI_DETECTOR_RISK_RECALL_MAX_WINDOWS=5` (default) controls the number of prioritized windows per coalesced detector flush; capped at 10. One per video in a flush.
- Process-wide `ProviderScheduler` still enforces existing API limits.
- No direct YouTube API or TranscriptAPI changes; transcript credit budget remains unchanged.

### Offline scan drift comparison (no API requests)

Point the comparison at two scan folders with `result.json` and `openai-analysis.json`:

```bash
SCAN_DRIFT_PREVIOUS_DIR='scan-results/<earlier-scan-id>' \
SCAN_DRIFT_CURRENT_DIR='scan-results/<later-scan-id>' \
npm run eval:scan-drift
```

The report lists disappearing events only on byte-identical normalized transcripts, and the cue windows the new fallback would select. The report does **not** prove the model will detect all cues after the additional call.

### Acceptance criteria for follow-up

- Re-run 10-video Compot scan and confirm that the missing armed pursuit is reported without inflating innocent weapon mention.
- Compare 9 identical videos and at least two non-Minecraft channels with manually labelled severe scenes.
- Measure per-scan P50/P95 latency, input tokens and recall-call count; if latency exceeds 60 seconds consistently, reduce the recall cap **based on real evidence**, not speculative promises.
- Monitor `copyGroundingFallback` and manually review actual replacements; do not claim generalized semantic entailment checking.

No claim is made that repeated outputs are now identical.
