# YT Checker

A parent-oriented YouTube channel checker. The service scans recent videos and reports derived content detections with YouTube timeline ranges instead of publishing transcript text or producing an opaque "safe / unsafe" score.

## MVP scope

- Fetch the latest public channel uploads through TranscriptAPI's `/youtube/channel/latest` endpoint.
- Fetch timestamped transcripts through a replaceable provider adapter.
- Use deterministic regex rules to cheaply locate candidate timeline ranges.
- Optionally pass only small candidate context windows to TypeSafe Jev for contextual false-positive filtering.
- Return only derived categories, counts, severity, and YouTube timeline ranges.
- Return per-video failures without failing the entire channel scan.
- Do **not** persist, cache, log, or return raw transcript text.
- Do **not** require a YouTube Data API key.

Jev is deliberately used as a conservative second layer, not as the sole detector. A regex candidate is removed only when Jev classifies it as benign with a high configured probability. Ambiguous or low-confidence cases stay visible so a parent can verify the original YouTube moment.

## Docker-only local setup

You do not need Node.js or npm installed on the host. The intended local workflow requires only Docker Desktop / Docker Compose.

Create the local environment file:

```bash
cp .env.example .env
```

Set:

- `NUXT_TRANSCRIPT_API_KEY` — TranscriptAPI server-side API key.
- `NUXT_TYPESAFE_API_KEY` — TypeSafe API key. Optional: without it, the service runs regex-only.

Start development:

```bash
docker compose up --build
```

Then open `http://localhost:3000`.

The source tree is mounted read-only into the container. Dependencies and Nuxt-generated files live in Docker-managed volumes rather than in host `node_modules`.

Stop the stack:

```bash
docker compose down
```

Remove generated Docker volumes too:

```bash
docker compose down -v
```

## Checks

Run all type checks, tests, and the production build inside Docker:

```bash
docker build --target verify .
```

CI uses the same Docker verification target, so local and CI environments stay aligned.

## Production image

Build the minimal runtime image:

```bash
docker build --target runtime -t yt-checker:local .
```

Or run the hardened production compose definition locally:

```bash
docker compose -f compose.prod.yaml up --build -d
```

Both compose definitions bind port 3000 only to `127.0.0.1`. Put a properly configured reverse proxy in front when deploying publicly rather than changing the application container to privileged mode.

See [SECURITY.md](./SECURITY.md) for the container threat model and remaining risks.

## Data flow

```text
Channel URL
   |
   v
TranscriptAPI /channel/latest
   |
   v
recent video metadata
   |
   v
TranscriptAPI /youtube/transcript
   |
   | raw transcript: server memory only
   v
regex candidate finder
   |
   | only short local context windows
   v
TypeSafe Jev (optional)
   |
   | confident benign -> drop
   | violation/uncertain/low confidence -> keep
   v
derived detections only:
category + count + severity + timeline ranges
```

If Jev is unavailable for a video, the service falls back to the conservative regex candidates rather than silently losing detections.

## Raw content policy

Raw transcript content is transient processing input.

It must never be:

- written to the database;
- written to application logs;
- cached;
- sent to analytics/error tracking;
- included in API responses;
- displayed in the UI.

When Jev contextual filtering is enabled, only a bounded local window around a regex candidate (the matched segment plus at most one neighboring segment on each side, capped in length) is sent to TypeSafe. The full transcript is not sent to Jev.

Persistent/output data is limited to video/channel identifiers and metadata plus our own derived classification: category, count, severity, time ranges, and classifier/rule version when versioning is added.

The transcript provider is isolated behind `VideoSource` and `TranscriptProvider`; contextual filtering is isolated behind `ContextFilter`, so either upstream dependency can be replaced independently.

## Transcript provider benchmark

The repository includes a Docker-only benchmark for comparing `transcriptapi.com` and `transcriptapi.io` on exactly the same 50 videos.

Add both provider keys to `.env`:

```env
BENCHMARK_TRANSCRIPT_COM_KEY=...
BENCHMARK_TRANSCRIPT_IO_KEY=...
```

By default the benchmark discovers the latest 50 videos from `@TED` through the `.io` channel-list endpoint, then sends those exact 50 IDs to both transcript providers. Override the dataset with:

```env
BENCHMARK_CHANNEL=@someChannel
BENCHMARK_LANGUAGE=ru
```

Or freeze an exact list:

```env
BENCHMARK_VIDEO_IDS=id1,id2,...,id50
```

Run:

```bash
mkdir -p benchmark-results
docker compose --profile benchmark run --rm benchmark
```

The report compares success rate, observed latency (average/p50/p95), segment counts, transcript length, final timestamp coverage, normalized-text equality, and token-set similarity.

Raw transcript text is never written to disk or printed. It exists only in benchmark process memory long enough to calculate aggregate comparison metrics. Results are written to `benchmark-results/latest.md` and `benchmark-results/latest.json`, which are ignored by Git.

Provider billing note: successful `.com` transcript requests cost one credit. `.io` also prices a transcript fetch at one credit, but documented cache hits are free, so the benchmark's actual `.io` credit consumption can be below the number of successful requests.
\n### Detailed diagnostic benchmark artifacts\n\nThe provider benchmark is intentionally more permissive than production data handling. It saves complete provider responses locally under benchmark-results/ so we can inspect exactly what each API returned. That directory is ignored by Git and must never be committed.\n\nThe default benchmark scans up to 100 channel videos with the free transcriptapi.com /youtube/info endpoint, then builds a 50-video main dataset while trying to include up to 10 no-caption candidates. Both providers receive exactly the same main 50 IDs.\n\nOptional benchmark settings:\n\n    BENCHMARK_VIDEO_COUNT=50\n    BENCHMARK_DISCOVERY_POOL=100\n    BENCHMARK_NO_CAPTIONS_TARGET=10\n    BENCHMARK_NO_CAPTIONS_VIDEO_IDS=idA,idB,idC\n    BENCHMARK_CAPTURE_RAW=true\n\nThe output includes summary.md/json, details.md, dataset.json, no-captions.md/json, discovery preflight responses, and one directory per video containing com-info.json, com-transcript.json, io-transcript.json, and analysis.json.\n\nRaw transcript responses, response headers, error bodies, provider source/language fields, timestamps, metadata, cache/credit headers when present, previews, hashes, timing metrics and cross-provider similarity data are retained for the diagnostic run. API authorization values are always redacted.\n\nThe no-captions report explicitly records whether either provider failed, whether transcriptapi.io recovered a transcript, and the exact io source field. A successful response with source=asr after the caption preflight failed is treated as direct evidence of ASR fallback for that tested video.\n\nBecause these files may contain complete third-party transcript text, delete benchmark-results/ after analysis. They are not application storage and do not change the production raw-content policy.\n