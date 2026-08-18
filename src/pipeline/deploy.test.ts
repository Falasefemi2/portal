import { describe, expect, it } from "@effect/vitest"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect, FileSystem, Layer, Option, Sink, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { layer as fileSystemLayer } from "@effect/platform-bun/BunFileSystem"
import { list as tarList } from "tar"
import { layer as builderLayer } from "../builder/builder.js"
import { RuntimeConfig } from "../config/runtime.js"
import { StorageError } from "../core/errors.js"
import { DeployService, layer as deployLayer } from "./deploy.js"
import { Registry, testLayer as registryTestLayer } from "../registry/registry.js"
import { Storage, testLayer as storageTestLayer } from "../storage/storage.js"

interface Script {
  readonly exitCode: number
  readonly output: string
}

const encoder = new TextEncoder()

const gitSha = "abc123def456"
const buildScript: Script = { exitCode: 0, output: "building...\ndone" }
const failureScript: Script = { exitCode: 1, output: "error: boom" }

const withTempDir = (prefix: string) =>
  Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), prefix))),
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore)
  )

const withProjectDir = (files: Record<string, string>) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const dir = await mkdtemp(join(tmpdir(), "portal-pipeline-test-"))
      for (const [rel, content] of Object.entries(files)) {
        const abs = join(dir, rel)
        await mkdir(dirname(abs), { recursive: true })
        await writeFile(abs, content)
      }
      return dir
    }),
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore)
  )

const makeFakeSpawner = (script: Script) => {
  const commands: Array<ChildProcess.StandardCommand> = []
  const spawner = ChildProcessSpawner.make((command) => {
    const cmd = command as ChildProcess.StandardCommand
    commands.push(cmd)
    const isGit = cmd.command === "git"
    const output = isGit ? `${gitSha}\n` : script.output
    const exitCode = isGit ? 0 : script.exitCode
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.fromIterable([encoder.encode(output)]),
        stderr: Stream.empty,
        all: Stream.fromIterable([encoder.encode(output)]),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void)
      })
    )
  })
  return { spawner, commands }
}

const failingStorageLayer = Layer.effect(
  Storage,
  Effect.sync(() =>
    Storage.of({
      putObject: () =>
        new StorageError({ operation: "Storage.putObject", cause: new Error("upload failed") }),
      getObject: () =>
        new StorageError({ operation: "Storage.getObject", cause: new Error("get failed") }),
      listVersions: () =>
        new StorageError({ operation: "Storage.listVersions", cause: new Error("list failed") }),
      deleteObject: () =>
        new StorageError({ operation: "Storage.deleteObject", cause: new Error("delete failed") })
    })
  )
)

const withDeploy = <A, E, R>(
  dataDir: string,
  opts: { script: Script; storageLayer?: Layer.Layer<Storage, never, never> },
  effect: (commands: Array<ChildProcess.StandardCommand>) => Effect.Effect<A, E, R>
) => {
  const { spawner, commands } = makeFakeSpawner(opts.script)
  const runtimeConfig = RuntimeConfig.of({
    gcsBucket: "test-bucket",
    googleProjectId: Option.none(),
    databaseUrl: "sqlite::memory:",
    port: 8080,
    dataDir
  })
  const builderEnv = Layer.provideMerge(
    builderLayer,
    Layer.merge(fileSystemLayer, Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner))
  )
  const deployEnv = Layer.provideMerge(
    deployLayer,
    Layer.mergeAll(
      builderEnv,
      registryTestLayer,
      opts.storageLayer ?? storageTestLayer,
      Layer.succeed(RuntimeConfig, runtimeConfig)
    )
  )
  return Effect.provide(effect(commands), deployEnv)
}

const nodeProject = {
  "package.json": JSON.stringify({ name: "acme", scripts: { build: "echo hi" } }),
  "dist/index.html": "<h1>hi</h1>"
}

describe("DeployService.deploy", () => {
  it.effect("runs a successful deploy and records the artifact", () =>
    withProjectDir(nodeProject).pipe(
      Effect.flatMap((dir) =>
        withTempDir("portal-pipeline-data-").pipe(
          Effect.flatMap((dataDir) =>
            withDeploy(dataDir, { script: buildScript }, () =>
              Effect.gen(function* () {
                const service = yield* DeployService
                const registry = yield* Registry
                const storage = yield* Storage
                const fs = yield* FileSystem.FileSystem

                const record = yield* service.deploy(dir)

                expect(record.status).toBe("succeeded")
                expect(record.project).toBe("acme")
                expect(record.gitSha).toBe(gitSha)
                expect(record.artifactPath).toBe(`acme/${record.deployId}/artifact.tar.gz`)
                expect(record.buildLogRef).toBeDefined()

                const stored = yield* registry.getDeploy(record.deployId)
                expect(stored.status).toBe("succeeded")
                expect(stored.artifactPath).toBe(record.artifactPath)

                const log = yield* fs.readFileString(record.buildLogRef!)
                expect(log).toBe("building...\ndone")

                yield* withTempDir("portal-pipeline-out-").pipe(
                  Effect.flatMap((out) =>
                    Effect.gen(function* () {
                      const dest = join(out, "artifact.tar.gz")
                      yield* storage.getObject(record.artifactPath!, dest)
                      const entries: Array<string> = []
                      yield* Effect.promise(() =>
                        tarList({ file: dest, onReadEntry: (entry) => entries.push(entry.path) })
                      )
                      expect(entries.some((p) => p.endsWith("index.html"))).toBe(true)
                    })
                  )
                )
              })
            )
          )
        )
      )
    )
  )

  it.effect("marks the deploy failed and raises BuildFailed on a failing build", () =>
    withProjectDir(nodeProject).pipe(
      Effect.flatMap((dir) =>
        withTempDir("portal-pipeline-data-").pipe(
          Effect.flatMap((dataDir) =>
            withDeploy(dataDir, { script: failureScript }, () =>
              Effect.gen(function* () {
                const service = yield* DeployService
                const registry = yield* Registry

                const failure = yield* service.deploy(dir).pipe(Effect.flip)
                expect(failure._tag).toBe("BuildFailed")
                if (failure._tag === "BuildFailed") {
                  expect(failure.log).toContain("boom")
                }

                const deploys = yield* registry.listDeploys()
                expect(deploys).toHaveLength(1)
                expect(deploys[0]?.status).toBe("failed")
              })
            )
          )
        )
      )
    )
  )

  it.effect("marks the deploy failed and raises UploadFailed when upload fails", () =>
    withProjectDir(nodeProject).pipe(
      Effect.flatMap((dir) =>
        withTempDir("portal-pipeline-data-").pipe(
          Effect.flatMap((dataDir) =>
            withDeploy(dataDir, { script: buildScript, storageLayer: failingStorageLayer }, () =>
              Effect.gen(function* () {
                const service = yield* DeployService
                const registry = yield* Registry

                const failure = yield* service.deploy(dir).pipe(Effect.flip)
                expect(failure._tag).toBe("UploadFailed")

                const deploys = yield* registry.listDeploys()
                expect(deploys).toHaveLength(1)
                expect(deploys[0]?.status).toBe("failed")
              })
            )
          )
        )
      )
    )
  )
})