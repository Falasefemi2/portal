# Portal

A local-first deploy platform (Vercel-style demo). Point Portal at a local git
repo, and it builds the project, packages the output, uploads the artifact to a
Google Cloud Storage bucket, and serves it locally on request.

Built with [Bun](https://bun.com) and [Effect](https://effect.website) (v4).

## Status

All modules are implemented and tested (41 tests): core model and errors,
runtime config, GCS storage, Postgres registry, builder, deploy pipeline,
server, and CLI. Built in reviewable increments per [AGENTS.md](./AGENTS.md).

## CLI usage

```
portal deploy <path>    build, package, upload, and record a deploy
portal list             list recorded deploys (production marked)
portal promote <id>     point the production alias at a deploy
portal logs <id>        print a deploy's build log
portal serve            run the local portal server
```

Run it with Bun: `bun run index.ts deploy <path>`. Requires the environment
variables in [`.env.example`](./.env.example) — see
[Environment](#environment).

## How it works

The core loop mirrors Vercel's deploy pipeline, minus the distributed pieces:

1. **Input** — a local git repo path.
2. **Build** — project type is detected (static site or Node project with a
   `build` script), and the build runs in an isolated step, producing a build
   output directory.
3. **Package** — the build output is archived.
4. **Upload** — the artifact is pushed to a GCS bucket under a versioned path,
   e.g. `gs://<bucket>/<project>/<deploy-id>/`.
5. **Serve** — a local server resolves a `project` (optionally through an alias
   such as `production`) to the right artifact and serves it.
6. **Record** — deploy metadata (id, timestamp, git sha, status, GCS path) is
   persisted and queryable.

### Architecture

| Module | Responsibility |
| --- | --- |
| `src/core` | Error definitions and the shared data model (deploy records, project config, aliases). |
| `src/config` | Runtime configuration (database URL, GCS bucket, server port, data dir). |
| `src/registry` | Metadata store. Persists deploy records and aliases (Postgres via `@effect/sql-pg`); ships an in-memory test layer. |
| `src/storage` | Artifact storage. `putObject` / `getObject` / `listVersions` / `deleteObject` over GCS (`@google-cloud/storage`); ships an in-memory test layer. |
| `src/builder` | Project detection, build runner (shells out), and artifact packaging (tar). |
| `src/pipeline` | Deploy orchestration tying builder, storage, and registry together. |
| `src/server` | Local HTTP server with alias resolution and a sync-to-disk serve cache. |
| `src/cli` | `portal deploy`, `portal list`, `portal promote`, `portal logs`, `portal serve` (Effect CLI). |

Dependency direction: `core` and `config` are leaf modules. `registry` and
`storage` depend on `core` and `config`. The pipeline composes `builder`,
`storage`, and `registry`. The server and CLI consume the pipeline.

### Key design decisions

- **Effect services with swappable layers.** Every I/O boundary (registry,
  storage, build runner) is an Effect service with a real layer and an
  in-memory test layer, so the pipeline and server can be tested without GCS or
  Postgres.
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

## Environment

Portal reads configuration from environment variables (see
[`.env.example`](./.env.example)). Copy it to `.env` and fill it in — Bun loads
`.env` automatically:

```bash
cp .env.example .env
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `GCS_BUCKET` | yes | GCS bucket name that stores deploy artifacts |
| `GOOGLE_PROJECT_ID` | no | GCP project that owns the bucket |
| `DATABASE_URL` | yes | Postgres connection string for the deploy registry |
| `PORT` | no (default `8080`) | Local server port |
| `DATA_DIR` | no (default `.portal`) | Local state: build logs, serve cache |

`GCS_BUCKET` and `DATABASE_URL` are required for every command because the
layer stack builds eagerly — `--help` included. If either is missing the CLI
exits with a config error.

### How to get the keys

**GCS artifact storage**

1. Create a Google Cloud project: https://console.cloud.google.com (note its
   project id).
2. In the project, open **Cloud Storage** and create a bucket. The bucket name
   must be globally unique, e.g. `my-portal-bucket`. Or, with the `gcloud` CLI:

   ```bash
   gcloud projects create portal-demo --name="Portal demo"
   gcloud auth login
   gcloud config set project portal-demo
   gcloud storage buckets create gs://my-portal-bucket
   ```

3. Create a service account: **IAM & Admin → Service Accounts → Create service
   account** (e.g. `portal-deployer`). Grant it the **Storage Object Admin**
   role (bucket-scoped is enough).
4. **Keys → Add key → Create new key → JSON**. A key file downloads — this is
   your credential. Keep it out of the repo (add it to `.gitignore` if you
   store it in the project).
5. Point the GCS client at it and configure Portal:

   ```bash
   GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/portal-sa-key.json
   GCS_BUCKET=my-portal-bucket
   GOOGLE_PROJECT_ID=portal-demo
   ```

   `@google-cloud/storage` reads `GOOGLE_APPLICATION_CREDENTIALS` to
   authenticate. Alternative to the key file: run `gcloud auth
   application-default login` to use Application Default Credentials instead.

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

## Scope notes (v0)

Out of scope for v0: multi-region / edge distribution, GitHub App or
webhook-triggered deploys, containerized build isolation, auth /
multi-tenant dashboards, and rollback automation beyond `promote`.
