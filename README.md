# Portal

A local-first deploy platform (Vercel-style demo). Point Portal at a local git
repo, and it builds the project, packages the output, uploads the artifact to a
Google Cloud Storage bucket, and serves it locally on request.

Built with [Bun](https://bun.com) and [Effect](https://effect.website) (v4).

## Status

Early-stage implementation, built in reviewable increments per
[AGENTS.md](./AGENTS.md). Storage and registry layers are done and tested; the
builder, pipeline, server, and CLI are next.

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
| `src/builder` | Project detection, build runner, and artifact packaging. (Planned.) |
| `src/pipeline` | Deploy orchestration tying builder, storage, and registry together. (Planned.) |
| `src/server` | Local HTTP server with alias resolution and a sync-to-disk serve cache. (Planned.) |
| `src/cli` | `portal deploy`, `portal list`, `portal promote`, `portal logs`. (Planned.) |

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

## Development

Requires [Bun](https://bun.com) (tested on v1.3.x).

```bash
bun install        # install dependencies
bun run test       # run the vitest suite
bun run lint       # oxlint
bunx tsc --noEmit  # typecheck
bun run index.ts   # current placeholder entry point
```

Tests use vitest via `@effect/vitest` — run them with `bun run test`, not
`bun test` (Bun's native runner is not compatible with `@effect/vitest`).

## Scope notes (v0)

Out of scope for v0: multi-region / edge distribution, GitHub App or
webhook-triggered deploys, containerized build isolation, auth /
multi-tenant dashboards, and rollback automation beyond `promote`.
