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
8. Optionally pass only bounded candidate context to TypeSafe Jev for contextual false-positive filtering.
9. Return derived categories, counts, severity and YouTube timeline ranges.

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
