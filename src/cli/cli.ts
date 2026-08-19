import { join, resolve } from "node:path"
import { layer as bunHttpServerLayer } from "@effect/platform-bun/BunHttpServer"
import { Effect, Exit, FileSystem, Scope, Stdio, Stream } from "effect"
import { Argument, CliError, Command } from "effect/unstable/cli"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { RuntimeConfig } from "../config/runtime.js"
import { type DeployError } from "../core/errors.js"
import { makeDeployId } from "../core/model.js"
import { DeployService } from "../pipeline/deploy.js"
import { Registry } from "../registry/registry.js"
import { serve } from "../server/server.js"

const writeLine = Effect.fn("Cli.writeLine")(function* (line: string) {
  const stdio = yield* Stdio.Stdio
  yield* Stream.fromIterable([`${line}\n`]).pipe(Stream.run(stdio.stdout()))
})

const deployErrorMessage = (error: DeployError): string => {
  switch (error._tag) {
    case "ProjectNotFound":
      return `project not found at ${error.project}`
    case "ConfigInvalid":
      return `invalid portal config at ${error.path}`
    case "BuildFailed":
      return `build failed for ${error.project} (exit ${error.exitCode})`
    case "PackageFailed":
      return `failed to package build output for ${error.project}: ${describeError(error.cause)}`
    case "UploadFailed":
      return `failed to upload artifact for ${error.project} (${error.deployId}): ${describeError(error.cause)}`
    case "DeployNotFound":
      return `deploy ${error.deployId} not found`
    case "RegistryError":
      return `deploy registry error during ${error.operation}: ${describeError(error.cause)}`
  }
}

const describeError = (cause: unknown): string => {
  if (cause instanceof Error) {
    const inner = describeError((cause as { cause?: unknown }).cause)
    return inner === "" ? cause.message : `${cause.message}: ${inner}`
  }
  return cause === undefined ? "" : String(cause)
}

const isRemoteUrl = (input: string): boolean => /^(https?:\/\/|git@|ssh:\/\/)/.test(input)

const cloneRepo = Effect.fn("Cli.cloneRepo")(function* (url: string) {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const runtime = yield* RuntimeConfig

  const clonesRoot = join(runtime.dataDir, "clones")
  const safeName = url.replace(/^https?:\/\//, "").replace(/[^A-Za-z0-9._-]/g, "-").replace(/\.git$/, "")
  const target = join(clonesRoot, safeName)

  yield* fs.remove(target, { recursive: true, force: true }).pipe(Effect.orElseSucceed(() => undefined))
  yield* fs.makeDirectory(clonesRoot, { recursive: true })

  const exitCode = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make("git", ["clone", "--depth", "1", url, target], {})
      )
      return yield* handle.exitCode
    })
  )
  if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
    return yield* new CliError.UserError({
      cause: new Error(`git clone failed for ${url} (exit ${exitCode})`),
      userMessage: `failed to clone ${url}`
    })
  }
  return target
})

const toUserError = (cause: DeployError) =>
  new CliError.UserError({ cause, userMessage: deployErrorMessage(cause) })

const parseDeployId = (deployId: string) =>
  Effect.try({
    try: () => makeDeployId(deployId),
    catch: () =>
      new CliError.UserError({
        cause: new Error(`invalid deploy id ${deployId}`),
        userMessage: `invalid deploy id ${deployId}`
      })
  })

export const deploy = Effect.fn("Cli.deploy")(function* (path: string) {
  const service = yield* DeployService
  const rootDir = yield* isRemoteUrl(path) ? cloneRepo(path) : Effect.succeed(resolve(path))
  const record = yield* service.deploy(rootDir).pipe(Effect.mapError(toUserError))
  yield* writeLine(`deployed ${record.project} (${record.deployId}) at ${record.gitSha}`)
})

export const list = Effect.fn("Cli.list")(function* () {
  const registry = yield* Registry
  const records = yield* registry.listDeploys().pipe(Effect.mapError(toUserError))

  if (records.length === 0) {
    yield* writeLine("no deploys yet")
    return
  }

  for (const record of records) {
    const production = yield* registry
      .resolveAlias(record.project, "production")
      .pipe(
        Effect.catchTags({
          AliasNotFound: () => Effect.void,
          RegistryError: () => Effect.void
        })
      )
    const marker = production?.deployId === record.deployId ? " [production]" : ""
    yield* writeLine(`${record.deployId} ${record.project} ${record.status} ${record.gitSha}${marker}`)
  }
})

export const promote = Effect.fn("Cli.promote")(function* (deployId: string) {
  const registry = yield* Registry
  const id = yield* parseDeployId(deployId)
  const record = yield* registry.getDeploy(id).pipe(Effect.mapError(toUserError))

  if (record.status !== "succeeded") {
    return yield* new CliError.UserError({
      cause: new Error(`cannot promote deploy ${deployId} with status ${record.status}`),
      userMessage: `cannot promote deploy ${deployId}: status is ${record.status}`
    })
  }

  yield* registry.setAlias(record.project, "production", record.deployId).pipe(Effect.mapError(toUserError))
  yield* writeLine(`promoted ${deployId} to production`)
})

export const logs = Effect.fn("Cli.logs")(function* (deployId: string) {
  const registry = yield* Registry
  const fs = yield* FileSystem.FileSystem
  const id = yield* parseDeployId(deployId)
  const record = yield* registry.getDeploy(id).pipe(Effect.mapError(toUserError))

  const ref = record.buildLogRef
  if (ref === undefined) {
    yield* writeLine(`no build log recorded for ${deployId}`)
    return
  }

  const text = yield* fs.readFileString(ref)
  yield* writeLine(text.trimEnd())
})

export const serveCli = Effect.fn("Cli.serve")(function* () {
  const runtime = yield* RuntimeConfig
  yield* writeLine(`portal listening on http://localhost:${runtime.port}`)
  const scope = yield* Scope.make()
  const serving = serve().pipe(
    Effect.provideService(Scope.Scope, scope),
    Effect.andThen(Effect.never)
  )
  return yield* Effect.provide(bunHttpServerLayer({ port: runtime.port }))(serving).pipe(
    Effect.ensuring(Scope.close(scope, Exit.void))
  )
})

const deployCommand = Command.make("deploy", { path: Argument.string("path") }, ({ path }) => deploy(path)).pipe(
  Command.withDescription("Build, package and upload the project at PATH, then record the deploy")
)

const listCommand = Command.make("list", {}, () => list()).pipe(
  Command.withDescription("List recorded deploys")
)

const promoteCommand = Command.make(
  "promote",
  { deployId: Argument.string("deploy-id") },
  ({ deployId }) => promote(deployId)
).pipe(
  Command.withDescription("Point the production alias at DEPLOY_ID")
)

const logsCommand = Command.make(
  "logs",
  { deployId: Argument.string("deploy-id") },
  ({ deployId }) => logs(deployId)
).pipe(
  Command.withDescription("Print the build log for DEPLOY_ID")
)

const serveCommand = Command.make("serve", {}, () => serveCli()).pipe(
  Command.withDescription("Run the local portal server")
)

const cli = Command.make("portal").pipe(
  Command.withSubcommands([deployCommand, listCommand, promoteCommand, logsCommand, serveCommand])
)

export const main = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.1.0", renderErrors: true })(args)
