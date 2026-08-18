import { describe, expect, it } from "@effect/vitest"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DateTime, Effect, Layer } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { layer as fileSystemLayer } from "@effect/platform-bun/BunFileSystem"
import { create as tarCreate } from "tar"
import { RuntimeConfig } from "../config/runtime.js"
import { makeDeployId, makeProjectName } from "../core/model.js"
import { layer as serverLayer, Server } from "./server.js"
import { testLayer as registryTestLayer, Registry } from "../registry/registry.js"
import { testLayer as storageTestLayer, Storage } from "../storage/storage.js"

const siteFiles: Record<string, string> = {
  "index.html": "<h1>acme home</h1>",
  "assets/app.js": "console.log('acme')",
  "about/index.html": "<h1>about</h1>"
}

const withTempDir = (prefix: string) =>
  Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), prefix))),
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore)
  )

const withSiteDir = () =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const dir = await mkdtemp(join(tmpdir(), "portal-server-site-"))
      for (const [rel, content] of Object.entries(siteFiles)) {
        const abs = join(dir, rel)
        await mkdir(dirname(abs), { recursive: true })
        await writeFile(abs, content)
      }
      return dir
    }),
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore)
  )

const withServer = <A, E, R>(dataDir: string, effect: Effect.Effect<A, E, R>) => {
  const runtimeConfig = RuntimeConfig.of({
    r2AccountId: "test-account",
    r2AccessKeyId: "test-access",
    r2SecretAccessKey: "test-secret",
    r2Bucket: "test-bucket",
    databaseUrl: "sqlite::memory:",
    port: 8080,
    dataDir
  })
  const layers = Layer.provideMerge(
    serverLayer,
    Layer.mergeAll(
      registryTestLayer,
      storageTestLayer,
      fileSystemLayer,
      Layer.succeed(RuntimeConfig, runtimeConfig)
    )
  )
  return Effect.provide(effect, layers)
}

const seedDeploy = (siteDir: string) =>
  Effect.gen(function* () {
    const storage = yield* Storage
    const registry = yield* Registry

    const tarPath = join(siteDir, "artifact.tar.gz")
    yield* Effect.promise(() => tarCreate({ gzip: true, file: tarPath, cwd: siteDir }, ["."]))
    yield* storage.putObject("acme/dpl-1/artifact.tar.gz", tarPath)

    const deployId = makeDeployId("dpl-1")
    const createdAt = yield* DateTime.now
    yield* registry.createDeploy({
      deployId,
      project: makeProjectName("acme"),
      gitSha: "abc123",
      createdAt
    })
    yield* registry.updateDeploy(deployId, {
      status: "succeeded",
      artifactPath: "acme/dpl-1/artifact.tar.gz"
    })
    yield* registry.setAlias(makeProjectName("acme"), "production", deployId)
  })

const bodyOf = (response: HttpServerResponse.HttpServerResponse) =>
  Effect.promise(() => HttpServerResponse.toWeb(response).text())

describe("Server.handle", () => {
  it.effect("serves the production alias from the cache", () =>
    withSiteDir().pipe(
      Effect.flatMap((siteDir) =>
        withTempDir("portal-server-data-").pipe(
          Effect.flatMap((dataDir) =>
            withServer(dataDir,
              Effect.gen(function* () {
                yield* seedDeploy(siteDir)
                const server = yield* Server

                const first = yield* server.handle("/acme/production")
                expect(first.status).toBe(200)
                expect(yield* bodyOf(first)).toBe("<h1>acme home</h1>")

                const second = yield* server.handle("/acme/production")
                expect(second.status).toBe(200)
                expect(yield* bodyOf(second)).toBe("<h1>acme home</h1>")
              })
            )
          )
        )
      )
    )
  )

  it.effect("serves a file from a specific deploy id", () =>
    withSiteDir().pipe(
      Effect.flatMap((siteDir) =>
        withTempDir("portal-server-data-").pipe(
          Effect.flatMap((dataDir) =>
            withServer(dataDir,
              Effect.gen(function* () {
                yield* seedDeploy(siteDir)
                const server = yield* Server

                const response = yield* server.handle("/acme/dpl-1/assets/app.js")
                expect(response.status).toBe(200)
                expect(yield* bodyOf(response)).toBe("console.log('acme')")
              })
            )
          )
        )
      )
    )
  )

  it.effect("serves nested index.html for directory paths", () =>
    withSiteDir().pipe(
      Effect.flatMap((siteDir) =>
        withTempDir("portal-server-data-").pipe(
          Effect.flatMap((dataDir) =>
            withServer(dataDir,
              Effect.gen(function* () {
                yield* seedDeploy(siteDir)
                const server = yield* Server

                const response = yield* server.handle("/acme/production/about/")
                expect(response.status).toBe(200)
                expect(yield* bodyOf(response)).toBe("<h1>about</h1>")
              })
            )
          )
        )
      )
    )
  )

  it.effect("returns 404 for an unknown ref", () =>
    withSiteDir().pipe(
      Effect.flatMap((siteDir) =>
        withTempDir("portal-server-data-").pipe(
          Effect.flatMap((dataDir) =>
            withServer(dataDir,
              Effect.gen(function* () {
                yield* seedDeploy(siteDir)
                const server = yield* Server
                const response = yield* server.handle("/acme/does-not-exist")
                expect(response.status).toBe(404)
              })
            )
          )
        )
      )
    )
  )

  it.effect("returns 404 for a missing file", () =>
    withSiteDir().pipe(
      Effect.flatMap((siteDir) =>
        withTempDir("portal-server-data-").pipe(
          Effect.flatMap((dataDir) =>
            withServer(dataDir,
              Effect.gen(function* () {
                yield* seedDeploy(siteDir)
                const server = yield* Server
                const response = yield* server.handle("/acme/production/nope.png")
                expect(response.status).toBe(404)
              })
            )
          )
        )
      )
    )
  )

  it.effect("rejects path traversal", () =>
    withSiteDir().pipe(
      Effect.flatMap((siteDir) =>
        withTempDir("portal-server-data-").pipe(
          Effect.flatMap((dataDir) =>
            withServer(dataDir,
              Effect.gen(function* () {
                yield* seedDeploy(siteDir)
                const server = yield* Server
                const response = yield* server.handle("/acme/production/../../secret.txt")
                expect(response.status).toBe(404)
              })
            )
          )
        )
      )
    )
  )

  it.effect("lists projects at the root", () =>
    withSiteDir().pipe(
      Effect.flatMap((siteDir) =>
        withTempDir("portal-server-data-").pipe(
          Effect.flatMap((dataDir) =>
            withServer(dataDir,
              Effect.gen(function* () {
                yield* seedDeploy(siteDir)
                const server = yield* Server
                const response = yield* server.handle("/")
                expect(response.status).toBe(200)
                expect(yield* bodyOf(response)).toBe("acme")
              })
            )
          )
        )
      )
    )
  )

  it.effect("reports health", () =>
    withTempDir("portal-server-data-").pipe(
      Effect.flatMap((dataDir) =>
        withServer(dataDir,
          Effect.gen(function* () {
            const server = yield* Server
            const response = yield* server.handle("/health")
            expect(response.status).toBe(200)
            expect(yield* bodyOf(response)).toBe("ok")
          })
        )
      )
    )
  )
})