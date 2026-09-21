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
