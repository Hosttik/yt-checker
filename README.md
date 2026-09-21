# YT Checker

A parent-oriented YouTube channel checker. The service scans recent videos and reports derived content detections with YouTube timeline ranges instead of publishing transcript text or producing an opaque "safe / unsafe" score.

## MVP scope

- Fetch the latest public channel uploads through TranscriptAPI's `/youtube/channel/latest` endpoint.
- Fetch timestamped transcripts through a replaceable provider adapter.
- Apply deterministic speech rules in server memory.
- Return only derived categories, counts, severity, and YouTube timeline ranges.
- Return per-video failures without failing the entire channel scan.
- Do **not** persist, cache, log, or return raw transcript text.
- Do **not** require a YouTube Data API key.

The current rule engine is deliberately conservative and keyword-based. It is evidence location, not a claim that a channel is safe for children. Contextual classification and family-specific policies are the next layer.

## Local setup

Requirements: Node.js 22+.

```bash
cp .env.example .env
npm install
npm run dev
```

Set:

- `NUXT_TRANSCRIPT_API_KEY` — TranscriptAPI server-side API key.

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
   | raw transcript: memory only
   v
rule engine
   |
   | transcript discarded
   v
derived detections only:
category + count + severity + timeline ranges
```

## Raw content policy

Raw transcript content is transient processing input.

It must never be:

- written to the database;
- written to application logs;
- cached;
- sent to analytics/error tracking;
- included in API responses;
- displayed in the UI.

Persistent/output data is limited to video/channel identifiers and metadata plus our own derived classification: category, count, severity, time ranges, and classifier/rule version when versioning is added.

The provider is isolated behind `VideoSource` and `TranscriptProvider` interfaces so the upstream source can be replaced without changing the analysis layer.
