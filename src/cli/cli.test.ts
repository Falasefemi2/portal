import { describe, expect, it } from "@effect/vitest"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DateTime, Effect, FileSystem, Layer, Sink, Stdio, Stream } from "effect"
import { CliError } from "effect/unstable/cli"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { layer as fileSystemLayer } from "@effect/platform-bun/BunFileSystem"
import { layer as builderLayer } from "../builder/builder.js"
import { RuntimeConfig } from "../config/runtime.js"
import { makeDeployId, makeProjectName } from "../core/model.js"
import { deploy, list, logs, promote } from "./cli.js"
import { layer as deployLayer } from "../pipeline/deploy.js"
import { testLayer as registryTestLayer, Registry } from "../registry/registry.js"
import { testLayer as storageTestLayer, Storage } from "../storage/storage.js"

interface Script {
  readonly exitCode: number
  readonly output: string
}

const encoder = new TextEncoder()

const gitSha = "abc123def456"
const buildScript: Script = { exitCode: 0, output: "building...\ndone" }
const failureScript: Script = { exitCode: 1, output: "error: boom" }

const nodeProject = {
  "package.json": JSON.stringify({ name: "acme", scripts: { build: "echo hi" } }),
  "dist/index.html": "<h1>hi</h1>"
}

const withTempDir = (prefix: string) =>
  Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), prefix))),
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore)
  )

const withProjectDir = (files: Record<string, string>) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const dir = await mkdtemp(join(tmpdir(), "portal-cli-test-"))
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
  const spawner = ChildProcessSpawner.make((command) => {
    const cmd = command as ChildProcess.StandardCommand
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
  return spawner
}

const toText = (chunk: string | Uint8Array): string =>
  typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)

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

const withCli = <A, E, R>(
  dataDir: string,
  opts: { script: Script; storageLayer?: Layer.Layer<Storage, never, never>; spawner?: ReturnType<typeof ChildProcessSpawner.make> },
  out: Array<string>,
  effect: Effect.Effect<A, E, R>
) => {
  const runtimeConfig = RuntimeConfig.of({
    supabaseProjectRef: "test-project",
    supabaseAccessKeyId: "test-access",
    supabaseSecretAccessKey: "test-secret",
    supabaseBucket: "test-bucket",
    supabaseS3Region: "us-east-1",
    databaseUrl: "sqlite::memory:",
    port: 8080,
    dataDir
  })
  const spawner = opts.spawner ?? makeFakeSpawner(opts.script)
  const builderEnv = Layer.provideMerge(
    builderLayer,
    Layer.merge(fileSystemLayer, Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner))
  )
  const cliEnv = Layer.provideMerge(
    Layer.mergeAll(deployLayer),
    Layer.mergeAll(
      builderEnv,
      registryTestLayer,
      opts.storageLayer ?? storageTestLayer,
      fileSystemLayer,
      Layer.succeed(RuntimeConfig, runtimeConfig),
      capturingStdio(out)
    )
  )
  return Effect.provide(effect, cliEnv)
}

describe("cli", () => {
  it.effect("deploy deploys a project and prints the record", () =>
    withProjectDir(nodeProject).pipe(
      Effect.flatMap((dir) =>
        withTempDir("portal-cli-data-").pipe(
          Effect.flatMap((dataDir) => {
            const out: Array<string> = []
            return withCli(dataDir, { script: buildScript }, out,
              Effect.gen(function* () {
                yield* deploy(dir)

                const registry = yield* Registry
                const records = yield* registry.listDeploys()
                expect(records).toHaveLength(1)
                expect(records[0]?.status).toBe("succeeded")
                expect(out.join("")).toContain(`deployed acme (${records[0]?.deployId}) at ${gitSha}`)
              })
            )
          })
        )
      )
    )
  )

  it.effect("deploy raises a user error and marks the deploy failed on a failing build", () =>
    withProjectDir(nodeProject).pipe(
      Effect.flatMap((dir) =>
        withTempDir("portal-cli-data-").pipe(
          Effect.flatMap((dataDir) => {
            const out: Array<string> = []
            return withCli(dataDir, { script: failureScript }, out,
              Effect.gen(function* () {
                const failure = yield* deploy(dir).pipe(Effect.flip)
                expect(failure).toBeInstanceOf(CliError.UserError)
                if (failure instanceof CliError.UserError) {
                  expect(failure.userMessage).toContain("build failed")
                }

                const registry = yield* Registry
                const records = yield* registry.listDeploys()
                expect(records[0]?.status).toBe("failed")
              })
            )
          })
        )
      )
    )
  )

  it.effect("promote points the production alias at a deploy id", () =>
    withProjectDir(nodeProject).pipe(
      Effect.flatMap((dir) =>
        withTempDir("portal-cli-data-").pipe(
          Effect.flatMap((dataDir) => {
            const out: Array<string> = []
            return withCli(dataDir, { script: buildScript }, out,
              Effect.gen(function* () {
                yield* deploy(dir)

                const registry = yield* Registry
                const [record] = yield* registry.listDeploys()

                yield* promote(record!.deployId)

                const resolved = yield* registry.resolveAlias(record!.project, "production")
                expect(resolved.deployId).toBe(record!.deployId)
                expect(out.join("")).toContain(`promoted ${record!.deployId} to production`)
              })
            )
          })
        )
      )
    )
  )

  it.effect("promote rejects a deploy that is not succeeded", () =>
    withProjectDir(nodeProject).pipe(
      Effect.flatMap((_dir) =>
        withTempDir("portal-cli-data-").pipe(
          Effect.flatMap((dataDir) => {
            const out: Array<string> = []
            return withCli(dataDir, { script: buildScript }, out,
              Effect.gen(function* () {
                const registry = yield* Registry
                const deployId = makeDeployId("dpl-1")
                const createdAt = yield* DateTime.now
                yield* registry.createDeploy({
                  deployId,
                  project: makeProjectName("acme"),
                  gitSha,
                  createdAt
                })
                yield* registry.updateDeploy(deployId, { status: "failed" })

                const failure = yield* promote(deployId).pipe(Effect.flip)
                expect(failure).toBeInstanceOf(CliError.UserError)
                if (failure instanceof CliError.UserError) {
                  expect(failure.userMessage).toContain("cannot promote")
                }
              })
            )
          })
        )
      )
    )
  )

  it.effect("logs prints the recorded build log", () =>
    withProjectDir(nodeProject).pipe(
      Effect.flatMap((dir) =>
        withTempDir("portal-cli-data-").pipe(
          Effect.flatMap((dataDir) => {
            const out: Array<string> = []
            return withCli(dataDir, { script: buildScript }, out,
              Effect.gen(function* () {
                yield* deploy(dir)

                const registry = yield* Registry
                const [record] = yield* registry.listDeploys()

                yield* logs(record!.deployId)

                expect(out.join("")).toContain("building...\ndone")
              })
            )
          })
        )
      )
    )
  )

  it.effect("deploy clones a remote URL into the data dir before deploying", () =>
    withTempDir("portal-cli-data-").pipe(
      Effect.flatMap((dataDir) => {
        const out: Array<string> = []
        const base = makeFakeSpawner(buildScript)
        const urlSpawner = ChildProcessSpawner.make((command) => {
          const cmd = command as ChildProcess.StandardCommand
          if (cmd.command === "git" && cmd.args[0] === "clone") {
            const target = cmd.args[cmd.args.length - 1] ?? ""
            return Effect.gen(function* () {
              yield* Effect.promise(async () => {
                await mkdir(join(target, "dist"), { recursive: true })
                await writeFile(
                  join(target, "package.json"),
                  JSON.stringify({ name: "easyrent", scripts: { build: "echo hi" } })
                )
                await writeFile(join(target, "dist", "index.html"), "<h1>hi</h1>")
              })
              return yield* base.spawn(command)
            })
          }
          return base.spawn(command)
        })
        return withCli(dataDir, { script: buildScript, spawner: urlSpawner }, out,
          Effect.gen(function* () {
            yield* deploy("https://github.com/Falasefemi2/easyrent")

            const registry = yield* Registry
            const [record] = yield* registry.listDeploys()
            expect(record?.status).toBe("succeeded")
            expect(record?.project).toBe("easyrent")
            expect(out.join("")).toContain(`deployed easyrent (${record?.deployId}) at ${gitSha}`)

            const fs = yield* FileSystem.FileSystem
            const clonedProject = yield* fs.exists(join(dataDir, "clones", "github.com-Falasefemi2-easyrent", "package.json"))
            expect(clonedProject).toBe(true)
          })
        )
      })
    )
  )

  it.effect("list prints recorded deploys and the production marker", () =>
    withProjectDir(nodeProject).pipe(
      Effect.flatMap((dir) =>
        withTempDir("portal-cli-data-").pipe(
          Effect.flatMap((dataDir) => {
            const out: Array<string> = []
            return withCli(dataDir, { script: buildScript }, out,
              Effect.gen(function* () {
                yield* deploy(dir)

                const registry = yield* Registry
                const [record] = yield* registry.listDeploys()
                yield* registry.setAlias(record!.project, "production", record!.deployId)

                yield* list()

                expect(out.join("")).toContain(
                  `${record!.deployId} acme succeeded ${gitSha} [production]`
                )
              })
            )
          })
        )
      )
    )
  )
})
