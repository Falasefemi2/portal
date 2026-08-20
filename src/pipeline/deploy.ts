import { randomUUID } from "node:crypto"
import { basename, join } from "node:path"
import { Context, DateTime, Effect, FileSystem, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Builder } from "../builder/builder.js"
import { RuntimeConfig } from "../config/runtime.js"
import { type DeployError, UploadFailed } from "../core/errors.js"
import { DeployId, DeployRecord, makeDeployId, makeProjectName } from "../core/model.js"
import { Registry } from "../registry/registry.js"
import { Storage } from "../storage/storage.js"

export class DeployService extends Context.Service<DeployService, {
  readonly deploy: (rootDir: string) => Effect.Effect<DeployRecord, DeployError>
}>()("portal/pipeline/DeployService") {}

export const layer = Layer.effect(
  DeployService,
  Effect.gen(function* () {
    const builder = yield* Builder
    const registry = yield* Registry
    const storage = yield* Storage
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const fs = yield* FileSystem.FileSystem
    const runtime = yield* RuntimeConfig

    const markFailed = (deployId: DeployId) =>
      registry.updateDeploy(deployId, { status: "failed" }).pipe(Effect.catch(() => Effect.void))

    const writeBuildLog = Effect.fn("DeployService.writeBuildLog")(function* (
      deployId: DeployId,
      log: string
    ) {
      const logDir = join(runtime.dataDir, "logs")
      const logPath = join(logDir, `${deployId}.log`)
      yield* fs.makeDirectory(logDir, { recursive: true })
      yield* fs.writeFileString(logPath, log)
      return logPath
    })

    const deploy = Effect.fn("DeployService.deploy")(
      function* (rootDir: string): Effect.fn.Return<DeployRecord, DeployError> {
        const deployId = yield* Effect.sync(() => makeDeployId(randomUUID()))
        const createdAt = yield* DateTime.now
        const gitSha = yield* spawner
          .string(ChildProcess.make("git", ["rev-parse", "HEAD"], { cwd: rootDir }))
          .pipe(
            Effect.map((sha) => sha.trim()),
            Effect.orElseSucceed(() => "")
          )

        const projectConfig = yield* builder.detectProject(rootDir).pipe(
          Effect.catchTag("ConfigInvalid", (cause) =>
            Effect.gen(function* () {
              const inferredRaw = /^(https?:\/\/|git@|ssh:\/\/)/.test(rootDir)
                ? rootDir.replace(/^https?:\/\//, "").split("/").pop()?.replace(/\.git$/, "") ?? basename(rootDir)
                : basename(rootDir)
              const inferred = inferredRaw || "unknown"
              let name: ReturnType<typeof makeProjectName>
              try {
                name = makeProjectName(inferred)
              } catch {
                name = makeProjectName("unknown")
              }
              const detail =
                cause.cause instanceof Error ? cause.cause.message : String(cause.cause ?? cause.message ?? "")
              const log = `[portal] config error at ${cause.path}\n${detail}\n—\nFix: add a "build" script to package.json or a portal.config.json with { "buildCommand": "npm run build" }`
              yield* registry.createDeploy({ deployId, project: name, gitSha: gitSha || "unknown", createdAt }).pipe(Effect.orElseSucceed(() => undefined as unknown as DeployRecord))
              const logPath = yield* writeBuildLog(deployId, log).pipe(Effect.orElseSucceed(() => undefined as unknown as string))
              if (logPath) {
                yield* registry.updateDeploy(deployId, { status: "failed", buildLogRef: logPath }).pipe(Effect.orElseSucceed(() => undefined as unknown as DeployRecord))
              } else {
                yield* markFailed(deployId)
              }
              return yield* Effect.fail(cause)
            })
          )
        )

        // Success path — create the running record (not yet created in the failure branch above)
        yield* registry.createDeploy({ deployId, project: projectConfig.name, gitSha: gitSha || "unknown", createdAt })

        const buildOutput = yield* builder.build(projectConfig, rootDir).pipe(
          Effect.tapError((e) =>
            Effect.gen(function* () {
              const log = `[portal] build failed\n${(e as { log?: string }).log ?? String((e as { cause?: unknown }).cause ?? e)}`
              const p = yield* writeBuildLog(deployId, log).pipe(Effect.orElseSucceed(() => undefined as unknown as string))
              if (p) yield* registry.updateDeploy(deployId, { status: "failed", buildLogRef: p }).pipe(Effect.orElseSucceed(() => undefined as unknown as DeployRecord))
              else yield* markFailed(deployId)
            })
          )
        )

        const artifactKey = `${projectConfig.name}/${deployId}/artifact.tar.gz`
        const buildLogRef = yield* writeBuildLog(deployId, buildOutput.buildLog).pipe(
          Effect.orElseSucceed(() => undefined)
        )

        const artifactPath = yield* builder
          .packageArtifact(projectConfig.name, buildOutput.outputDir, join(runtime.dataDir, "artifacts", deployId, "artifact.tar.gz"))
          .pipe(Effect.tapError(() => markFailed(deployId)))

        yield* storage.putObject(artifactKey, artifactPath).pipe(
          Effect.mapError(
            (cause) => new UploadFailed({ project: projectConfig.name, deployId, cause })
          ),
          Effect.tapError(() => markFailed(deployId))
        )

        return yield* registry.updateDeploy(deployId, {
          status: "succeeded",
          artifactPath: artifactKey,
          buildLogRef
        })
      }
    )

    return DeployService.of({ deploy })
  })
)
