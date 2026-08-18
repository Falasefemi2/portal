import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { Context, DateTime, Effect, FileSystem, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Builder } from "../builder/builder.js"
import { RuntimeConfig } from "../config/runtime.js"
import { type DeployError, UploadFailed } from "../core/errors.js"
import { DeployId, DeployRecord, makeDeployId } from "../core/model.js"
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
        const projectConfig = yield* builder.detectProject(rootDir)

        const gitSha = yield* spawner
          .string(ChildProcess.make("git", ["rev-parse", "HEAD"], { cwd: rootDir }))
          .pipe(
            Effect.map((sha) => sha.trim()),
            Effect.orElseSucceed(() => "")
          )
        const deployId = yield* Effect.sync(() => makeDeployId(randomUUID()))
        const createdAt = yield* DateTime.now

        yield* registry.createDeploy({ deployId, project: projectConfig.name, gitSha: gitSha || "unknown", createdAt })

        const buildOutput = yield* builder.build(projectConfig, rootDir).pipe(
          Effect.tapError(() => markFailed(deployId))
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