# YT Checker

A parent-oriented YouTube channel checker. The service scans recent videos, obtains timestamped transcripts, and reports concrete rule violations instead of producing an opaque "safe / unsafe" score.

## MVP scope

- Resolve a public YouTube channel by handle, channel ID, or legacy username.
- Fetch recent uploads through the official YouTube Data API.
- Fetch timestamped transcripts through a replaceable provider adapter (Supadata first).
- Apply deterministic speech rules with timestamped evidence.
- Return per-video failures without failing the entire channel scan.
- Do **not** store video/audio/full transcripts.

The current rule engine is deliberately conservative and keyword-based. It is evidence collection, not a claim that a channel is safe for children. Contextual AI classification and family-specific policies are the next layer.

## Local setup

Requirements: Node.js 22+.

```bash
cp .env.example .env
npm install
npm run dev
```

Set:

- `NUXT_YOUTUBE_API_KEY` — YouTube Data API v3 key.
- `NUXT_SUPADATA_API_KEY` — Supadata API key.

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
   +--> YouTube Data API --> channel + recent video metadata
   |
   +--> Supadata adapter --> timestamped transcript
                               |
                               v
                         deterministic rules
                               |
                               v
                    violations + timestamps
```

The transcript integration lives behind `TranscriptProvider`, so the provider can be replaced without changing the analysis layer.
