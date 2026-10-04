# Security model

YT Checker uses containers to reduce host exposure and keep the development/runtime environment reproducible. Containers are one security boundary, not a guarantee that dependencies or application code are safe.

## Container hardening

The default development container:

- runs as the non-root `node` user;
- drops all Linux capabilities;
- enables `no-new-privileges`;
- uses a read-only root filesystem;
- mounts the source repository read-only;
- gives write access only to dedicated Docker volumes/tmpfs and `scan-results`;
- binds the application port only to `127.0.0.1`;
- does not mount the Docker socket;
- does not use privileged mode;
- applies process, memory and CPU limits.

The production compose file uses a dedicated `scan_data` volume rather than mounting the source tree.

## Secrets

`.env` is ignored by Git and excluded from Docker build context. API keys are injected only at runtime.

Authorization values captured in diagnostic provider/classifier exchanges are replaced with `Bearer <redacted>`.

Docker is not a secrets vault: code running in the application container can access secrets deliberately supplied to that container.

## Storage modes and raw transcripts

### none

No scan artifact is persisted.

### minimal

The result includes exact short transcript excerpts as violation evidence. Full transcripts are not stored in minimal mode.

### diagnostic

Diagnostic mode intentionally records raw TranscriptAPI responses and OpenAI analysis diagnostics. This can include complete third-party transcript text, the normalized transcript, and structured model output. OpenAI API keys are never recorded.

Diagnostic mode therefore:

- is disabled unless `NUXT_ALLOW_DIAGNOSTIC_STORAGE=true`;
- must not be enabled as the public production default;
- must use a private storage location;
- must not feed raw artifacts into analytics/error tracking;
- requires explicit deletion/retention rules before any hosted use.

Full transcripts remain transient in normal production; detections, quoted evidence, reasons and timestamps are persisted.

## Dependency risk

Docker prevents npm packages from being installed directly into the host OS, but malicious dependencies can still execute inside a build/container and access resources exposed to that container.

Current mitigations include non-root execution, read-only source mounts, capability dropping, no Docker socket and restricted writable paths.

The Docker build uses the committed `package-lock.json` with `npm ci`, so CI and local container builds install the reviewed dependency graph rather than re-resolving semver ranges.


## Raw phrase logging

Exact transcript phrases and bounded context may contain third-party content and potentially sensitive speech. They are therefore excluded from normal production logs.

Raw phrases are not printed to stdout. Diagnostic storage requires explicit server enablement.

`transcriptapi-exchanges.json` and `openai-analysis.json` must be treated as raw diagnostic data rather than normal product data.
