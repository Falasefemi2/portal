import { mkdir } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { Context, Effect, FileSystem, Layer, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { create as createTar } from "tar"
import { BuildFailed, ConfigInvalid, PackageFailed } from "../core/errors.js"
import { ProjectConfig, ProjectName, makeProjectName } from "../core/model.js"

export interface BuildOutput {
  readonly outputDir: string
  readonly buildLog: string
}

const PortalConfigJson = Schema.Struct({
  name: Schema.optionalKey(ProjectName),
  buildCommand: Schema.optionalKey(Schema.NonEmptyString),
  outputDir: Schema.optionalKey(Schema.NonEmptyString),
  static: Schema.optionalKey(Schema.Boolean)
})
type PortalConfigJson = Schema.Schema.Type<typeof PortalConfigJson>

const PackageJson = Schema.Struct({
  name: Schema.optionalKey(Schema.NonEmptyString),
  module: Schema.optionalKey(Schema.NonEmptyString),
  scripts: Schema.optionalKey(
    Schema.Struct({
      build: Schema.optionalKey(Schema.NonEmptyString)
    })
  )
})

const decodeJson = <A>(path: string, raw: string, schema: Schema.ConstraintDecoder<A, never>) =>
  Effect.try({
    // SAFETY: JSON.parse returns any; the schema decode below validates the parsed shape before it is used.
    try: () => JSON.parse(raw) as unknown,
    catch: (cause) => new ConfigInvalid({ path, cause })
  }).pipe(
    Effect.flatMap((value) => Schema.decodeUnknownEffect(schema)(value)),
    Effect.mapError((cause) => new ConfigInvalid({ path, cause }))
  )

const readJson = <A>(
  fs: FileSystem.FileSystem,
  path: string,
  schema: Schema.ConstraintDecoder<A, never>
): Effect.Effect<A, ConfigInvalid> =>
  fs.readFileString(path).pipe(
    Effect.mapError((cause) => new ConfigInvalid({ path, cause })),
    Effect.flatMap((raw) => decodeJson(path, raw, schema))
  )

export class Builder extends Context.Service<Builder, {
  readonly detectProject: (rootDir: string) => Effect.Effect<ProjectConfig, ConfigInvalid>
  readonly build: (config: ProjectConfig, rootDir: string) => Effect.Effect<BuildOutput, BuildFailed>
  readonly packageArtifact: (
    project: string,
    outputDir: string,
    destPath: string
  ) => Effect.Effect<string, PackageFailed>
}>()("portal/builder/Builder") {}

export const layer = Layer.effect(
  Builder,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

    const detectProject = Effect.fn("Builder.detectProject")(
      function* (rootDir: string): Effect.fn.Return<ProjectConfig, ConfigInvalid> {
        const configPath = join(rootDir, "portal.config.json")
      const hasConfig = yield* fs.exists(configPath).pipe(
        Effect.mapError((cause) => new ConfigInvalid({ path: configPath, cause }))
      )
      const portalConfig: PortalConfigJson | undefined = hasConfig
        ? yield* readJson(fs, configPath, PortalConfigJson)
        : undefined

      const pkgPath = join(rootDir, "package.json")
      const hasPackage = yield* fs.exists(pkgPath).pipe(
        Effect.mapError((cause) => new ConfigInvalid({ path: pkgPath, cause }))
      )
      const pkg = hasPackage ? yield* readJson(fs, pkgPath, PackageJson) : undefined

      const name = makeProjectName(portalConfig?.name ?? pkg?.name ?? basename(rootDir))

      const configuredBuild = portalConfig?.buildCommand
      const configuredOutput = portalConfig?.outputDir
      const hasBuildScript = pkg?.scripts?.build !== undefined
      const hasBuildCommand = configuredBuild !== undefined || hasBuildScript

      if (portalConfig?.static === true) {
        return { name, static: true, outputDir: configuredOutput ?? "." }
      }

      const hasIndexHtml = yield* fs.exists(join(rootDir, "index.html")).pipe(
        Effect.mapError((cause) => new ConfigInvalid({ path: rootDir, cause }))
      )
      const inferredStatic = hasBuildCommand === false && hasIndexHtml

      if (portalConfig?.static === false ? false : inferredStatic) {
        return { name, static: true, outputDir: configuredOutput ?? "." }
      }

      if (hasBuildCommand === false) {
        const moduleEntry = pkg?.module ?? "index.ts"
        const hasModuleFile = yield* fs.exists(join(rootDir, moduleEntry)).pipe(
          Effect.mapError((cause) => new ConfigInvalid({ path: rootDir, cause }))
        )
        if (hasModuleFile) {
          return {
            name,
            buildCommand: `bun build ${moduleEntry} --outdir dist --target=bun`,
            outputDir: configuredOutput ?? "dist"
          }
        }
        return yield* new ConfigInvalid({
          path: rootDir,
          cause: new Error("no build script in package.json, no portal.config.json buildCommand, and no Bun module entrypoint")
        })
      }

      return {
        name,
        buildCommand: configuredBuild ?? "npm run build",
        outputDir: configuredOutput ?? "dist"
      }
      }
    )

    const build = Effect.fn("Builder.build")(
      function* (config: ProjectConfig, rootDir: string): Effect.fn.Return<BuildOutput, BuildFailed> {
      const command = config.buildCommand

      if (config.static === true || command === undefined) {
        return { outputDir: resolve(rootDir, config.outputDir ?? "."), buildLog: "" }
      }

      const toBuildFailed = (cause: unknown) =>
        new BuildFailed({
          project: config.name,
          exitCode: -1,
          log: cause instanceof Error ? cause.message : String(cause)
        })

      const runCommand = Effect.fn("Builder.runCommand")(function* (cmd: string) {
        const commandValue = ChildProcess.make(cmd, { cwd: rootDir, shell: true })
        return yield* Effect.gen(function* () {
          const handle = yield* spawner.spawn(commandValue)
          const chunks = yield* handle.all.pipe(Stream.decodeText(), Stream.runCollect)
          const exitCode = yield* handle.exitCode
          return { log: chunks.join(""), exitCode }
        }).pipe(Effect.scoped)
      })

      const hasPackageJson = yield* fs.exists(join(rootDir, "package.json")).pipe(
        Effect.mapError(toBuildFailed)
      )
      if (hasPackageJson) {
        const hasNodeModules = yield* fs.exists(join(rootDir, "node_modules")).pipe(
          Effect.mapError(toBuildFailed)
        )
        if (!hasNodeModules) {
          const [hasBunLock, hasPackageLock] = yield* Effect.all([
            fs.exists(join(rootDir, "bun.lock")).pipe(Effect.mapError(toBuildFailed)),
            fs.exists(join(rootDir, "package-lock.json")).pipe(Effect.mapError(toBuildFailed))
          ])
          const installCommand = hasBunLock ? "bun install" : hasPackageLock ? "npm ci" : "npm install"
          const install = yield* runCommand(installCommand).pipe(Effect.mapError(toBuildFailed))
          if (install.exitCode !== ChildProcessSpawner.ExitCode(0)) {
            return yield* new BuildFailed({ project: config.name, exitCode: install.exitCode, log: install.log })
          }
        }
      }

      const result = yield* runCommand(command).pipe(Effect.mapError(toBuildFailed))

      if (result.exitCode !== ChildProcessSpawner.ExitCode(0)) {
        return yield* new BuildFailed({ project: config.name, exitCode: result.exitCode, log: result.log })
      }

      return { outputDir: resolve(rootDir, config.outputDir ?? "dist"), buildLog: result.log }
    })

    const packageArtifact = Effect.fn("Builder.packageArtifact")(
      function* (project: string, outputDir: string, destPath: string) {
        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(dirname(destPath), { recursive: true })
            await createTar({ gzip: true, file: destPath, cwd: outputDir }, ["."])
          },
          catch: (cause) => new PackageFailed({ project, cause })
        })
        return destPath
      }
    )

    return Builder.of({ detectProject, build, packageArtifact })
  })
)
