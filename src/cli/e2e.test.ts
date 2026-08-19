import { describe, expect, it } from "@effect/vitest"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect, Layer, Sink, Stdio, Stream } from "effect"
import { CliError } from "effect/unstable/cli"
import { HttpServer } from "effect/unstable/http"
import { layer as fileSystemLayer } from "@effect/platform-bun/BunFileSystem"
import { layer as pathLayer } from "@effect/platform-bun/BunPath"
import { layer as childProcessSpawnerLayer } from "@effect/platform-bun/BunChildProcessSpawner"
import { layer as terminalLayer } from "@effect/platform-bun/BunTerminal"
import { layer as builderLayer } from "../builder/builder.js"
import { RuntimeConfig } from "../config/runtime.js"
import { main } from "./cli.js"
import { layer as deployLayer } from "../pipeline/deploy.js"
import { testLayer as registryTestLayer, Registry } from "../registry/registry.js"
import { testLayer as storageTestLayer, Storage } from "../storage/storage.js"
import { Server } from "../server/server.js"

const withTempDir = (prefix: string) =>
  Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), prefix))),
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore)
  )

const withProjectDir = (files: Record<string, string>) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const dir = await mkdtemp(join(tmpdir(), "portal-e2e-project-"))
      for (const [rel, content] of Object.entries(files)) {
        const abs = join(dir, rel)
        await mkdir(dirname(abs), { recursive: true })
        await writeFile(abs, content)
      }
      return dir
    }),
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore)
  )

const toText = (chunk: string | Uint8Array): string =>
  chunk instanceof Uint8Array ? new TextDecoder().decode(chunk) : chunk

const capturingStdio = (lines: Array<string>): Layer.Layer<Stdio.Stdio> =>
  Layer.succeed(
    Stdio.Stdio,
    Stdio.make({
      args: Effect.succeed([]),
      stdout: () => Sink.forEach((chunk: string | Uint8Array) => Effect.sync(() => { lines.push(toText(chunk)) })),
      stderr: () => Sink.forEach((chunk: string | Uint8Array) => Effect.sync(() => { lines.push(toText(chunk)) })),
      stdin: Stream.empty
    })
  )

const withE2eCli = <A, E, R>(dataDir: string, out: Array<string>, effect: Effect.Effect<A, E, R>) => {
  const runtimeConfig = RuntimeConfig.of({
    supabaseProjectRef: "test-project",
    supabaseAccessKeyId: "test-access",
    supabaseSecretAccessKey: "test-secret",
    supabaseBucket: "e2e-bucket",
    supabaseS3Region: "us-east-1",
    databaseUrl: "postgres://unused",
    port: 8080,
    dataDir
  })
  const httpServerLayer = Layer.succeed(
    HttpServer.HttpServer,
    HttpServer.make({
      serve: () => Effect.never,
      address: { _tag: "TcpAddress", hostname: "localhost", port: runtimeConfig.port }
    })
  )
  const serverStub = Layer.succeed(Server, {
    handle: () => Effect.never
  })
  const spawnerEnv = Layer.provide(childProcessSpawnerLayer, Layer.merge(fileSystemLayer, pathLayer))
  const builderEnv = Layer.provideMerge(builderLayer, Layer.merge(fileSystemLayer, spawnerEnv))
  const serverEnv = Layer.provideMerge(
    serverStub,
    Layer.mergeAll(
      registryTestLayer,
      storageTestLayer,
      fileSystemLayer,
      Layer.succeed(RuntimeConfig, runtimeConfig),
      httpServerLayer
    )
  )
  const e2eEnv = Layer.provideMerge(
    Layer.mergeAll(deployLayer),
    Layer.mergeAll(
      builderEnv,
      serverEnv,
      fileSystemLayer,
      pathLayer,
      terminalLayer,
      capturingStdio(out)
    )
  )
  return Effect.provide(effect, e2eEnv)
}

const nodeProject = {
  "portal.config.json": JSON.stringify({
    name: "acme",
    buildCommand: "bun ./build.js",
    outputDir: "dist"
  }),
  "build.js": [
    "const { mkdirSync, writeFileSync } = require(\"node:fs\")",
    "console.log(\"building...\")",
    "mkdirSync(\"dist\", { recursive: true })",
    "writeFileSync(\"dist/index.html\", \"<h1>hi</h1>\")",
    "console.log(\"done\")"
  ].join("\n")
}

const failingProject = {
  "portal.config.json": JSON.stringify({
    name: "acme",
    buildCommand: "bun ./fail.js",
    outputDir: "dist"
  }),
  "fail.js": ["console.error(\"boom\")", "process.exit(1)"].join("\n")
}

describe("e2e", () => {
  it.effect("deploys through the real spawner and serves the recorded artifact", () =>
    withProjectDir(nodeProject).pipe(
      Effect.flatMap((dir) =>
        withTempDir("portal-e2e-data-").pipe(
          Effect.flatMap((dataDir) => {
            const out: Array<string> = []
            return withE2eCli(dataDir, out, Effect.gen(function* () {
              yield* main(["deploy", dir])

              const registry = yield* Registry
              const storage = yield* Storage
              const records = yield* registry.listDeploys()
              expect(records).toHaveLength(1)
              const record = records[0]
              expect(record?.status).toBe("succeeded")
              expect(record?.artifactPath).toBe(`acme/${record?.deployId}/artifact.tar.gz`)

              const objects = yield* storage.listVersions("acme/")
              expect(objects).toHaveLength(1)
              expect(out.join("")).toContain(`deployed acme (${record?.deployId})`)
            }))
          })
        )
      )
    )
  )

  it.effect("promotes and prints the recorded build log", () =>
    withProjectDir(nodeProject).pipe(
      Effect.flatMap((dir) =>
        withTempDir("portal-e2e-data-").pipe(
          Effect.flatMap((dataDir) => {
            const out: Array<string> = []
            return withE2eCli(dataDir, out, Effect.gen(function* () {
              yield* main(["deploy", dir])

              const registry = yield* Registry
              const records = yield* registry.listDeploys()
              const deployId = records[0]?.deployId
              const project = records[0]?.project
              expect(deployId).toBeDefined()
              expect(project).toBeDefined()

              out.length = 0
              yield* main(["promote", deployId!])
              expect(out.join("")).toContain(`promoted ${deployId} to production`)

              const alias = yield* registry.resolveAlias(project!, "production")
              expect(alias?.deployId).toBe(deployId)

              out.length = 0
              yield* main(["logs", deployId!])
              expect(out.join("")).toContain("building...")
              expect(out.join("")).toContain("done")
            }))
          })
        )
      )
    )
  )

  it.effect("surfaces a real build failure as a UserError and marks the deploy failed", () =>
    withProjectDir(failingProject).pipe(
      Effect.flatMap((dir) =>
        withTempDir("portal-e2e-data-").pipe(
          Effect.flatMap((dataDir) => {
            const out: Array<string> = []
            return withE2eCli(dataDir, out, Effect.gen(function* () {
              const failure = yield* Effect.flip(main(["deploy", dir]))
              expect(failure instanceof CliError.UserError).toBe(true)
              if (failure instanceof CliError.UserError) {
                expect(failure.userMessage).toContain("build failed")
              }

              const registry = yield* Registry
              const records = yield* registry.listDeploys()
              expect(records[0]?.status).toBe("failed")
            }))
          })
        )
      )
    )
  )
})