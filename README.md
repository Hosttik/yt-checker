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

## Local setup

Requirements: Node.js 22+.

```bash
cp .env.example .env
npm install
npm run dev
```

Set:

- `NUXT_TRANSCRIPT_API_KEY` — TranscriptAPI server-side API key.
- `NUXT_TYPESAFE_API_KEY` — TypeSafe API key. Optional: without it, the service runs regex-only.

Then open `http://localhost:3000`.

## Checks

```bash
npm run check
```

Runs strict Nuxt type checking, Vitest, and a production build.

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

When Jev contextual filtering is enabled, only a bounded local window around a regex candidate (the matched segment plus at most one neighboring segment on each side, capped in length) is sent to TypeSafe. The full transcript is not sent to Jev. TypeSafe's current customer agreement states that Customer Data is not used to train model weights without prior customer consent.

Persistent/output data is limited to video/channel identifiers and metadata plus our own derived classification: category, count, severity, time ranges, and classifier/rule version when versioning is added.

The transcript provider is isolated behind `VideoSource` and `TranscriptProvider`; contextual filtering is isolated behind `ContextFilter`, so either upstream dependency can be replaced independently.
