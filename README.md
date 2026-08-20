# Portal

A local-first deploy platform (Vercel-style demo). Point Portal at a local git
repo (or a GitHub URL), and it builds the project, packages the output, uploads
the artifact to a Supabase Storage bucket, and serves it locally on request.
Includes a JSON + SSE API for the `portal-frontend` dashboard — no dummy data.

Built with [Bun](https://bun.com) and [Effect](https://effect.website) (v4).

## Status

All modules implemented and tested (42 tests): core model and errors, runtime
config, Supabase Storage, Postgres registry, builder, deploy pipeline, server,
and CLI. API branch (`api`) adds the JSON/SSE surface consumed by
`portal-frontend`. Built in reviewable increments per `AGENTS.md`.

## CLI usage

```
portal deploy <path>    build, package, upload, and record a deploy
portal list             list recorded deploys (production marked)
portal promote <id>     point the production alias at a deploy
portal logs <id>        print a deploy's build log
portal serve            run the local portal server (static + API on :8080)
```

`deploy` takes a local git repo path or a GitHub URL (e.g.
`https://github.com/user/repo` — cloned into `DATA_DIR` before building). Run it
with Bun: `bun run index.ts deploy <path>`. Requires the environment variables
in [`.env.example`](./.env.example) — see [Environment](#environment).

## How it works

The core loop mirrors Vercel's deploy pipeline, minus the distributed pieces:

1. **Input** — a local git repo path or a GitHub URL.
2. **Build** — project type is detected (static site or Node project with a
   `build` script), dependencies are installed if missing, and the build runs in
   an isolated step, producing a build output directory.
3. **Package** — the build output is archived.
4. **Upload** — the artifact is pushed to a Supabase Storage bucket under a
   versioned path, e.g. `<bucket>/<project>/<deploy-id>/`.
5. **Serve** — a local server resolves a `project` (optionally through an alias
   such as `production`) to the right artifact and serves it.
6. **Record** — deploy metadata (id, timestamp, git sha, status, artifact path) is
   persisted and queryable.

### Architecture

| Module | Responsibility |
| --- | --- |
| `src/core` | Error definitions and the shared data model (deploy records, project config, aliases). |
| `src/config` | Runtime configuration (database URL, Supabase Storage, server port, data dir). |
| `src/registry` | Metadata store. Persists deploy records and aliases (Postgres via `@effect/sql-pg`); ships an in-memory test layer. |
| `src/storage` | Artifact storage. `putObject` / `getObject` / `listVersions` / `deleteObject` over Supabase Storage (`@aws-sdk/client-s3`); ships an in-memory test layer. |
| `src/builder` | Project detection, dependency install, build runner (shells out), and artifact packaging (tar). |
| `src/pipeline` | Deploy orchestration tying builder, storage, and registry together. |
| `src/server` | Local HTTP server with alias resolution, sync-to-disk serve cache, and JSON/SSE API (`src/server/api.ts`). |
| `src/cli` | `portal deploy`, `portal list`, `portal promote`, `portal logs`, `portal serve` (Effect CLI). |

Dependency direction: `core` and `config` are leaf modules. `registry` and
`storage` depend on `core` and `config`. The pipeline composes `builder`,
`storage`, and `registry`. The server and CLI consume the pipeline.

### Key design decisions

- **Effect services with swappable layers.** Every I/O boundary (registry,
  storage, build runner) is an Effect service with a real layer and an
  in-memory test layer, so the pipeline and server can be tested without
  Supabase Storage or Postgres.
- **Effect v4 (rc.110).** Everything is `Effect.gen` / combinators; no
  `async`/`await` inside Effect code.
- **Error channel, not exceptions.** Typed tagged errors
  (`ProjectNotFound`, `BuildFailed`, `UploadFailed`, ...) flow from services to
  CLI exit codes and server responses. See `src/core/errors.ts`.
- **Serve strategy.** The local server syncs the requested artifact from
  storage to a local cache directory, then serves it statically. Simpler than
  streaming per-request and fine for the demo; streaming is a future option.
- **Build isolation.** v0 shells out to the local toolchain. Containerized
  builds are a documented v1 risk, not a v0 feature.

## API (branch `api`) — consumed by `portal-frontend`

`portal serve` now serves both static artifacts **and** a JSON/SSE API under
`/api/*` (CORS `*`, `OPTIONS` preflight). Implemented in `src/server/api.ts`,
branched in `src/server/server.ts:157` before static handling.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/projects` | Groups `registry.listDeploys()` by `project`, includes `deployCount`, `lastDeploy`, `productionDeployId` via `resolveAlias(production)` |
| `GET` | `/api/projects/:project/deploys` | `registry.listDeploys(project)` sorted newest first |
| `GET` | `/api/deploys/:id` | `registry.getDeploy` |
| `GET` | `/api/deploys/:id/logs?sse=1` | SSE `text/event-stream` — tails `.portal/logs/:id.log` via `FileSystem`, emits `data: {line,at}` + `event: done` when status ≠ `running` |
| `GET` | `/api/deploys/:id/events` | SSE live status — polls `registry.getDeploy` every 1s, emits `event: status {status,at}` + `ping` keepalive |
| `GET` | `/api/health` | `{ok:true}` |
| `POST` | `/api/deploy` | `{path, buildCommand?}` — `forkDetach(DeployService.deploy(path))`, 202 with newest `DeployRecord` (portal writes `portal.config.json` if `buildCommand` supplied) |
| `POST` | `/api/deploys/:id/promote` | `registry.setAlias(project, "production", id)` — 409 if status ≠ `succeeded` |
| `POST` | `/api/deploys/:id/redeploy` | `{path}` required — `forkDetach(DeployService.deploy(path))`, 202 |

Static serving unchanged: `GET /` (newline project list), `GET /health`, `GET /:project/:ref/*` (artifact).

`DeployRecord` shape (`src/core/model.ts:15`): `{deployId, project, gitSha, status: running|succeeded|failed, createdAt, artifactPath?, buildLogRef?}`.

## Environment

Portal reads configuration from environment variables (see
[`.env.example`](./.env.example)). Copy it to `.env` and fill it in — Bun loads
`.env` automatically:

```bash
cp .env.example .env
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `SUPABASE_PROJECT_REF` | yes | Supabase project ref (part of the Storage S3 endpoint) |
| `SUPABASE_S3_ACCESS_KEY_ID` | yes | Supabase S3 access key |
| `SUPABASE_S3_SECRET_ACCESS_KEY` | yes | Supabase S3 secret key |
| `SUPABASE_S3_REGION` | yes | SigV4 signing region for the S3 endpoint — keep `us-east-1` (Supabase signs with it regardless of where the project is hosted) |
| `SUPABASE_BUCKET` | yes | Supabase Storage bucket that holds deploy artifacts |
| `DATABASE_URL` | yes | Postgres connection string for the deploy registry |
| `PORT` | no (default `8080`) | Local server port |
| `DATA_DIR` | no (default `.portal`) | Local state: build logs, serve cache |

The Supabase variables and `DATABASE_URL` are required for every command because the
layer stack builds eagerly — `--help` included. If any is missing the CLI
exits with a config error.

### How to get the keys

**Supabase artifact storage**

1. Sign in to https://supabase.com and open the project that will host the
   bucket.
2. In **Project Settings → API**, copy your **Project Ref** — the id that
   appears in the Storage S3 endpoint
   `https://<PROJECT_REF>.supabase.co/storage/v1/s3`.
3. Create a bucket: **Storage → New bucket**, e.g. `my-portal-bucket`.
4. Create an S3 access key: **Project Settings → API → Storage → S3 Access
   Keys → Create new key**. Copy the **Access Key ID** and **Secret Access
   Key** (the secret is shown once).
5. Configure Portal (use `us-east-1` as the region — Supabase's S3 gateway
   signs requests with it regardless of project region):

    ```bash
    SUPABASE_PROJECT_REF=abcdefghijklmnopqrst
    SUPABASE_S3_ACCESS_KEY_ID=e4f2...
    SUPABASE_S3_SECRET_ACCESS_KEY=9a2b...
    SUPABASE_S3_REGION=us-east-1
    SUPABASE_BUCKET=my-portal-bucket
    ```

**Postgres registry**

The registry needs a Postgres connection string for `DATABASE_URL` (tables are
auto-created on startup). Easiest local option — Docker:

```bash
docker run -d --name portal-db -e POSTGRES_PASSWORD=portal -p 5432:5432 postgres:16
# DATABASE_URL=postgresql://postgres:portal@localhost:5432/postgres
```

Or use a free managed Postgres (Neon, Supabase): create a project and copy its
connection string into `DATABASE_URL`.

## Development

Requires [Bun](https://bun.com) (tested on v1.3.x).

```bash
bun install        # install dependencies
bun run test       # run the vitest suite
bun run lint       # oxlint
bunx tsc --noEmit  # typecheck
bun run index.ts   # run the portal CLI (see "CLI usage")
```

Tests use vitest via `@effect/vitest` — run them with `bun run test`, not
`bun test` (Bun's native runner is not compatible with `@effect/vitest`).

### Running with the frontend

```bash
# terminal 1 — portal API + static serve
git checkout api
bun run index.ts serve
# → portal listening on http://localhost:8080

# terminal 2 — frontend (real data, no mocks)
cd ../portal-frontend
bun install
# NEXT_PUBLIC_PORTAL_URL defaults to http://localhost:8080
bun run dev        # http://localhost:3000
```

`bun run index.ts deploy <path>` still works — new deploys appear in the
frontend live via SSE (`/api/deploys/:id/events` + `/logs`).

## Scope notes (v0)

Out of scope for v0: multi-region / edge distribution, GitHub App or
webhook-triggered deploys, containerized build isolation, auth /
multi-tenant dashboards, and rollback automation beyond `promote`.
