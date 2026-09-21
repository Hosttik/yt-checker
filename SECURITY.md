# Security model

YT Checker uses containers to reduce host exposure and make the development/runtime environment reproducible. Containers are one security boundary, not a guarantee that dependencies or application code are safe.

## Local development hardening

The default `compose.yaml`:

- runs the application as the non-root `node` user from the image;
- drops all Linux capabilities;
- enables `no-new-privileges`;
- uses a read-only container root filesystem;
- mounts the host repository read-only;
- keeps `node_modules`, Nuxt build state, and output in Docker-managed volumes;
- gives the process only a small temporary `/tmp`;
- applies process, memory, and CPU limits;
- binds the development port only to `127.0.0.1`;
- never mounts the Docker socket;
- never uses privileged mode.

The production compose file does not mount the source tree at all.

## Secrets

`.env` is:

- ignored by Git;
- excluded from the Docker build context;
- injected only when a container starts.

Do not bake API keys into an image or commit them to the repository.

For a real hosted production deployment, use the hosting platform's secret manager instead of copying a developer `.env` file to the server.

A user who can control the Docker daemon can generally inspect or control containers and should be treated as highly privileged. Docker is not a secrets vault.

## Raw transcript policy

Containerization does not change the content-handling policy:

- raw transcripts are transient server-memory input;
- they must not be persisted, cached, logged, returned from our API, or displayed;
- only bounded candidate context may be sent to the configured contextual classifier;
- only derived detections and timeline ranges leave the analysis layer.

## Dependency risk

Docker prevents npm packages from being installed directly into the host OS, but malicious dependencies can still execute inside the build/container and can access resources explicitly exposed to that container.

Current mitigations include read-only source mounts, non-root execution, capability dropping, no Docker socket, and restricted filesystem writes.

A lockfile should be added and CI switched from `npm install` to `npm ci` once the dependency tree is intentionally frozen. Until then, semver ranges in `package.json` can resolve to newer dependency versions during image rebuilds.
