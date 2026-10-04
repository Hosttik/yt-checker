# YT Checker

Parent-oriented YouTube channel checker. The application uses **TranscriptAPI.com as the only YouTube data gateway**; it does not call the official YouTube Data API directly.

## Channel scan flow

A normal scan targets **10 successfully analyzed videos with captions**.

1. `GET /youtube/channel/latest` — fetch the latest 15 videos. Free.
2. `GET /youtube/info` — preflight candidate videos and keep only videos with available transcript languages. Free.
3. If the latest 15 do not contain enough captioned videos, fetch one `GET /youtube/channel/videos` page and continue the free `/youtube/info` preflights. A successful page costs 1 credit.
4. Request `GET /youtube/transcript` only for caption-eligible videos.
5. A successful transcript costs 1 credit. Failed transcript requests do not consume a credit.
6. Continue through eligible replacement videos until the requested number of successful transcript analyses is reached or the candidate pool is exhausted.
7. Run local regex candidate detection.
8. Optionally pass only bounded candidate context plus transcript-source metadata to TypeSafe Jev.
9. Resolve every candidate as `confirmed`, `needs_review`, or `dismissed`.
10. Return derived categories, confirmed/review counts, severity and YouTube timeline ranges.

Typical 10-video scan:

```text
/channel/latest       0 credits
/youtube/info         0 credits
10 successful
/youtube/transcript  10 credits
-------------------------------
total                10 credits
```

If a `/youtube/channel/videos` fallback page is required, the usual total is 11 credits.

TranscriptAPI charges paid endpoints only on successful HTTP 200 responses. Cached successful paid responses are also charged.

## Storage modes

The request supports three explicit modes.

### `none`

Nothing is persisted. Raw transcript exists only in process memory while the scan runs.

### `minimal` — default

Writes only:

```text
scan-results/<scan-id>/result.json
```

The result contains:

- channel/video metadata needed by the product;
- scan selection statistics;
- actual TranscriptAPI credit usage;
- transcript language;
- Jev status;
- derived rule categories/counts/severity;
- YouTube timeline ranges.

It does **not** contain transcript text or Jev candidate context.

### `diagnostic`

Writes the same derived `result.json` plus:

```text
transcriptapi-exchanges.json
jev-exchanges.json
```

These files contain the complete diagnostic exchange needed to understand provider/classifier behavior, including raw response bodies and candidate context. Authorization headers are redacted.

Diagnostic mode is disabled unless:

```env
NUXT_ALLOW_DIAGNOSTIC_STORAGE=true
```

Do not enable it as the production default.

## Docker-only local setup

Only Docker Desktop / Docker Compose is required on the host.

```bash
cp .env.example .env
mkdir -p scan-results
docker compose up --build
```

Required:

```env
NUXT_TRANSCRIPT_API_KEY=...
```

Optional Jev layer:

```env
NUXT_TYPESAFE_API_KEY=...
NUXT_JEV_BENIGN_DISMISS_THRESHOLD=0.75
NUXT_JEV_VIOLATION_CONFIRM_THRESHOLD=0.70
```

To use diagnostic storage locally:

```env
NUXT_ALLOW_DIAGNOSTIC_STORAGE=true
```

Open `http://localhost:3000`.

Local scan artifacts appear under:

```text
scan-results/<scan-id>/
```

The directory is ignored by Git and excluded from Docker build contexts.

## Checks

```bash
docker build --target verify .
```

CI runs type checking, Vitest and the production Nuxt build inside Docker, then smoke-tests the hardened runtime image.

## Production privacy boundary

The production default should remain `minimal` or `none`.

Raw transcript content must not be persisted, cached, logged, returned from our API or displayed in the UI. Only bounded candidate context may be sent to Jev. Persistent product data should remain derived analysis plus the minimum channel/video metadata needed to render the result.

See [SECURITY.md](./SECURITY.md) for the container and diagnostic-storage threat model.


## Production-like local run with full diagnostics

For local integration testing there is a dedicated production-image configuration with maximum diagnostics:

```bash
mkdir -p scan-results
docker compose -f compose.full-debug.yaml up --build
```

This mode forces:

```text
NODE_ENV=production (from the runtime image)
NUXT_LOG_LEVEL=debug
NUXT_ALLOW_DIAGNOSTIC_STORAGE=true
NUXT_PUBLIC_DEFAULT_STORAGE_MODE=diagnostic
```

The browser UI therefore opens with `Diagnostic` selected by default.

Operational logs are structured JSON and are visible with:

```bash
docker compose -f compose.full-debug.yaml logs -f app
```

Typical events include:

```text
scan.started
channel.latest.loaded
transcriptapi.exchange
video.preflight.completed
scan.selection.completed
video.analysis.started
video.regex.completed
jev.exchange
video.jev.completed
video.analysis.completed
scan.storage.completed
scan.completed
```

Stdout intentionally contains metadata only: status codes, latency, counts, video IDs, credit usage and state transitions. API keys and raw transcript/Jev context are not printed to stdout.

Complete diagnostic payloads are instead written to:

```text
scan-results/<scan-id>/
  result.json
  transcriptapi-exchanges.json
  jev-exchanges.json
```

`transcriptapi-exchanges.json` contains complete provider response bodies including transcript text. `jev-exchanges.json` contains the bounded candidate contexts sent to Jev. Authorization headers are redacted.

Docker stdout uses the `json-file` driver with rotation:

```text
max-size: 20m
max-file: 5
```

Stop the full-debug stack with:

```bash
docker compose -f compose.full-debug.yaml down
```

Delete diagnostic content when finished:

```bash
rm -rf scan-results/*
```

This configuration is intentionally for local/staging diagnosis. Do not expose it as the public production configuration because diagnostic artifacts contain raw third-party transcript text.


## Transcript language selection

The scan request accepts an optional `language` priority list supported by TranscriptAPI, for example:

```text
ru
ru,en
ru,en,asr
asr-ru
```

`/youtube/info` is used first for free language preflight. A plain code such as `ru` matches manual Russian captions first and auto-generated Russian captions as fallback. `asr` means any auto-generated captions. The paid transcript request receives the same language priority list, and the returned `transcriptLanguage` records the actual resolved track.

The UI exposes this as a language field with common presets plus free-form comma-separated priorities.

## Raw candidate diagnostics

Full-debug mode now records the exact text responsible for rule matches.

Structured events:

```text
transcript.request
transcript.retry
transcript.success
transcript.failed
candidate.regex_match
candidate.jev_result
candidate.final_resolution
```

When `NUXT_LOG_RAW_CANDIDATES=true` and the scan runs in `diagnostic` mode, stdout includes:

- rule ID and label;
- exact regex-matched term(s);
- the full caption segment treated as the phrase;
- bounded neighboring context;
- start/end timestamps;
- Jev choice, confidence and probabilities;
- final `confirmed`, `needs_review`, or `dismissed` resolution.

Diagnostic storage also writes:

```text
scan-results/<scan-id>/analysis-trace.json
```

This trace keeps the same phrase-level information even if Docker stdout rotates.

The dedicated full-debug Compose file enables:

```text
NUXT_LOG_LEVEL=debug
NUXT_LOG_RAW_CANDIDATES=true
NUXT_ALLOW_DIAGNOSTIC_STORAGE=true
NUXT_PUBLIC_DEFAULT_STORAGE_MODE=diagnostic
NUXT_PUBLIC_DEFAULT_TRANSCRIPT_LANGUAGE=ru
```

Raw candidate logging is intentionally not enabled by normal production configuration.


### Diagnostic result.json evidence

When a scan uses `storageMode: diagnostic`, the file written to disk at
`scan-results/<scan-id>/result.json` is enriched with raw evidence for every final candidate resolution.

Each video can contain:

```json
{
  "diagnosticEvidence": [
    {
      "candidateId": "c7",
      "ruleId": "insults",
      "ruleLabel": "Оскорбления",
      "hitCount": 1,
      "matchedTerms": ["дебил"],
      "phrase": "да ты дебил вообще",
      "context": "предыдущая фраза [CANDIDATE] да ты дебил вообще следующая фраза",
      "startMs": 12400,
      "endMs": 14400,
      "youtubeUrl": "https://www.youtube.com/watch?v=VIDEO_ID&t=12s",
      "resolution": "needs_review",
      "transcriptLanguage": "asr-ru",
      "transcriptSource": "asr",
      "jev": {
        "choice": "benign",
        "confidence": 0.47,
        "probabilities": { "benign": 0.65, "uncertain": 0.27, "violation": 0.08 }
      }
    }
  ]
}
```

For backward compatibility, non-dismissed evidence is also included in
`diagnosticViolations`. All three resolutions are included in `diagnosticEvidence`,
and all regex/Jev/retry decisions remain available in `analysis-trace.json`.

`selection.transcriptAttempts` remains a backward-compatible count of videos for
which transcript retrieval was attempted. The explicit fields are:

```json
{
  "transcriptVideosAttempted": 10,
  "transcriptHttpRequests": 12
}
```

`hitCount`/`count` mean all non-dismissed regex hits. `confirmedCount` and
`reviewCount` split that total by final resolution.

Jev decisions require finite confidence and all three probabilities in [0, 1],
with probabilities summing to 1 (rounding tolerance 0.02). Missing or malformed
scores resolve to `needs_review`. Confirmation requires both confidence and
violation probability >= 0.70; dismissal requires both confidence and benign
probability >= 0.75. The selected choice must have the largest probability.
Threshold overrides must be greater than 0.5 and at most 1.

Incident merging uses a 5-second gap, a maximum 25-second span, and never
discards evidence to fit the 900-character context limit. Compound matching
uses at most three segments within 10 seconds. Truncated candidate segments
remain `needs_review`. A paid successful HTTP response is accounted for even
if reading its body fails; it is not automatically requested and charged again.

This enrichment applies only to the diagnostic file persisted on disk. The public API response remains derived-only and does not expose raw transcript phrases.
