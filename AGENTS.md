# Project: Portal — local-first deploy platform (Vercel-style demo)

## Role & workflow contract (read this first, agent)

You are acting as a staff engineer pairing with me on architecture and implementation.
This is a **planning-first** engagement. Do not scaffold or write project code until I
explicitly say "go" on a plan.

Rules for how we work:

1. **Plan before code.** Produce a written plan (architecture, module boundaries, data
   flow, interfaces) and get my explicit sign-off before touching the filesystem.
2. **One file at a time.** Once we're building, write a single file (or a tightly
   coupled pair, e.g. a module + its test), then **stop**. Don't proceed to the next
   file until I've reviewed it and either approved or asked questions.
3. **No silent scope expansion.** If you think we need a file/module that wasn't in
   the agreed plan, name it and ask before creating it.
4. **Effect version discipline.** We're on the **latest Effect** (v4 line). If you are
   not certain an API/pattern is correct for v4 (vs. v3 muscle memory), **ask me or
   flag it as unverified** rather than guessing. Do not mix `async/await` inside
   Effect code — everything is `Effect.gen` / combinators.
5. **Be opinionated.** Flag design smells, hidden coupling, and premature abstraction
   as you go. I want pushback, not just execution.

---

## Product scope (v0 — local demo)

A minimal deploy pipeline that mimics the core Vercel loop, running entirely locally
except for artifact storage:

1. **Input**: a local git repo path (no GitHub integration in v0 — that's v1).
2. **Build**: detect project type (start with: static site / Node-buildable via a
   `build` script), run the build in an isolated step, produce a build output dir.
3. **Package**: tar/zip the build output.
4. **Upload**: push the artifact to a **Google Cloud Storage** bucket, versioned by
   deploy ID (e.g. `gs://<bucket>/<project>/<deploy-id>/`).
5. **Serve**: a local server process that resolves `project` (+ optional alias like
   "production" or a deploy ID) to the right GCS artifact and serves it — this is our
   stand-in for Vercel's edge routing.
6. **Deploy record**: persist deploy metadata (id, timestamp, git sha, status, GCS
   path) somewhere queryable — decide in planning whether that's SQLite, a flat
   JSON store, or Postgres via `effectq`-style tooling.
7. **CLI**: `portal deploy <path>`, `portal list`, `portal promote <deploy-id>` (alias →
   production), `portal logs <deploy-id>` at minimum.

**Explicitly out of scope for v0** (call out if any of these leak in during planning):
- Multi-region / edge distribution
- GitHub App / webhook-triggered deploys
- Build isolation via containers (v0 can shell out locally; note it as a v1 risk)
- Auth / multi-tenant dashboard
- Rollback automation beyond `promote`

---

## What I want from the planning phase (produce this, in order)

1. **Module/package boundaries** — how this is split (e.g. `core`, `builder`,
   `storage`, `registry`/metadata store, `cli`, `server`). State dependency direction
   between them.
2. **Effect service layer design** — what becomes an `Effect.Service` / `Context.Tag`,
   what the `Layer` composition looks like (esp. GCS client, metadata store, build
   runner as separate swappable layers — this matters for testing).
3. **Data model** — deploy record shape, project config shape (what does a
   `portal.config` file need to declare — build command, output dir, project name).
4. **Failure modes & error channel design** — what error types do we define
   (`BuildFailed`, `UploadFailed`, `ProjectNotFound`, etc.), and how do they propagate
   to CLI exit codes / server responses.
5. **Storage/GCS interface** — what's the minimal surface area we need
   (`putObject`, `getObject`, `listVersions`, signed URL or direct serve?), and do we
   wrap `@google-cloud/storage` directly or go through an Effect-native GCS client if
   one exists worth using.
6. **Serving strategy** — does the local server stream from GCS on each request, or
   sync-then-serve-from-disk with a cache? Trade-offs for the demo.
7. **Sequencing** — the concrete file-by-file build order we'll follow once planning
   is approved.

Stop after step 7 and wait for my go-ahead. Ask clarifying questions inline if
anything above is ambiguous — don't assume.
