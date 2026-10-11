# Scan calibration: Compot, 2026-10-11

Source: user-supplied scan `2026-10-11T09-21-23-122Z_e9b44d6a-9c79-4ae9-9539-0fa0cc49985b`.
The repository intentionally retains **only compact, provisional scene labels and short direct excerpts in tests**, not the full private diagnostic transcripts or provider exchanges.

## Baseline

- 10/10 videos analyzed, 0 provider failures
- 68,403 ms total vs 60,000 ms target
- 14 OpenAI requests, including 4 reviewer fallbacks; 10 TranscriptAPI credits
- 18 classified events, 13 parent-facing scenes
- 5 main / 8 details in original report

## Defects established from direct evidence

1. `tKmnOpeiIg0` at 434000 ms: a brief one-off refusal to release a gameplay character was promoted to high by a broad `threatened_harm` flag despite `duration=brief, repetition=single`. New policy requires sustained confinement or supported directed physical danger.
2. `MmdIhSW5B7Q` at 169680 ms: source "не сбежал" was paraphrased as "сбежавший". Parent-facing copy must preserve negation; fallback uses literal direct evidence.
3. `edgRlTMnF0o` at 480000 ms: high-risk police confrontation can remain visible, but the summary included later forensic findings and punishment not present in the selected direct evidence. Such information belongs in separately verified mitigating/context fields, not the evidence-anchored headline.
4. `wiuuBaYC8B8` at 375400 ms: highly dramatic fantasy black-hole peril should remain moderate, not high due to model intensity alone.
5. A gameplay sword demonstration with no harm should remain hidden.

## Offline replay (no paid API)

With a diagnostic `result.json` available on the developer machine:

```bash
OFFLINE_POLICY_REPLAY_FILE='scan-results/<scan-id>/result.json' npm run eval:offline-policy-replay
```

This computes fresh deterministic policy, runs conservative evidence-copy guards, shows relevance changes / fallback reasons and new per-video scene counts. On this exact scan it also checks the 13 provisional labels from `evals/gold/compot-2026-10-11.json`. The test does **not** request new transcripts or run OpenAI, so it does not measure missed events or changed LLM detector behavior.

To run model quality benchmarks on saved transcript data, use existing `eval:parental-quality` evaluation under deliberate API budget.

## Copy guard limitations

`content-evidence.ts` can detect **clear negation reversals** and **clauses with no lexical support** in selected evidence. It cannot guarantee general entailment, speaker attribution or paraphrase accuracy. When it triggers, the UI uses an exact, length-capped snippet from direct evidence rather than a made-up fluent narrative. The fallback is measured with `review.copyGroundingFallback`.

The reviewer prompt has also been tightened. It may still make subtler semantic mistakes: these require human-reviewed labels and (eventually) specialized verification, not just more string heuristics.

## Sign-off

The 13 labels are **provisional** (single reviewer); they are not an independently validated ground truth. Before declaring measurable improvement, obtain independent labels on 30–50 varied scenes including non-gameplay content, calculate main-screen precision/high false positives and missing serious events, and calibrate disagreements.

Performance optimization (especially the four reviewer fallback calls) is a separate iteration; no speed improvement is claimed by this policy/copy change.
