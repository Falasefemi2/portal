import { describe, expect, it } from "@effect/vitest"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { Effect, Layer, Sink, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { layer as fileSystemLayer } from "@effect/platform-bun/BunFileSystem"
import { list as tarList } from "tar"
import { Builder, layer as builderLayer } from "./builder.js"
import { makeProjectName } from "../core/model.js"

interface Script {
  readonly exitCode: number
  readonly output: string
}

const encoder = new TextEncoder()

const successScript: Script = { exitCode: 0, output: "building...\ndone" }
const failureScript: Script = { exitCode: 1, output: "error: boom" }

const withProjectDir = (files: Record<string, string>) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const dir = await mkdtemp(join(tmpdir(), "portal-builder-test-"))
      for (const [rel, content] of Object.entries(files)) {
        const abs = join(dir, rel)
        await mkdir(dirname(abs), { recursive: true })
        await writeFile(abs, content)
      }
      return dir
    }),
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore)
  )

const withBuilder = <A, E>(
  script: Script,
  effect: (commands: Array<ChildProcess.StandardCommand>) => Effect.Effect<A, E, Builder>
) => {
  const commands: Array<ChildProcess.StandardCommand> = []
  const spawner = ChildProcessSpawner.make((command) => {
    // SAFETY: The fake spawner only ever receives StandardCommand instances created by ChildProcess.make in the code under test.
    commands.push(command as ChildProcess.StandardCommand)
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(script.exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.fromIterable([encoder.encode(script.output)]),
        stderr: Stream.empty,
        all: Stream.fromIterable([encoder.encode(script.output)]),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void)
      })
    )
  })
  const layer = Layer.provide(
    builderLayer,
    Layer.merge(fileSystemLayer, Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner))
  )
  return Effect.provide(effect(commands), layer)
}

describe("Builder.detectProject", () => {
  it.effect("detects a node project from package.json", () =>
    withProjectDir({
      "package.json": JSON.stringify({ name: "acme", scripts: { build: "echo hi" } })
    }).pipe(
      Effect.flatMap((dir) =>
        withBuilder(successScript, () =>
          Effect.gen(function* () {
            const builder = yield* Builder
            const config = yield* builder.detectProject(dir)
            expect(config.name).toBe("acme")
            expect(config.buildCommand).toBe("npm run build")
            expect(config.outputDir).toBe("dist")
            expect(config.static).toBeUndefined()
          })
        )
      )
    )
  )

  it.effect("lets portal.config.json override package.json", () =>
    withProjectDir({
      "package.json": JSON.stringify({ name: "acme", scripts: { build: "echo hi" } }),
      "portal.config.json": JSON.stringify({
        name: "portal-app",
        buildCommand: "bun run build",
        outputDir: "build"
      })
    }).pipe(
      Effect.flatMap((dir) =>
        withBuilder(successScript, () =>
          Effect.gen(function* () {
            const builder = yield* Builder
            const config = yield* builder.detectProject(dir)
            expect(config.name).toBe("portal-app")
            expect(config.buildCommand).toBe("bun run build")
            expect(config.outputDir).toBe("build")
          })
        )
      )
    )
  )

  it.effect("infers a static project from index.html", () =>
    withProjectDir({ "index.html": "<h1>hello</h1>" }).pipe(
      Effect.flatMap((dir) =>
        withBuilder(successScript, () =>
          Effect.gen(function* () {
            const builder = yield* Builder
            const config = yield* builder.detectProject(dir)
            expect(config.name).toBe(basename(dir))
            expect(config.static).toBe(true)
            expect(config.outputDir).toBe(".")
            expect(config.buildCommand).toBeUndefined()
          })
        )
      )
    )
  )

  it.effect("honors an explicit static flag even with a build script", () =>
    withProjectDir({
      "package.json": JSON.stringify({ name: "acme", scripts: { build: "echo hi" } }),
      "portal.config.json": JSON.stringify({ static: true })
    }).pipe(
      Effect.flatMap((dir) =>
        withBuilder(successScript, () =>
          Effect.gen(function* () {
            const builder = yield* Builder
            const config = yield* builder.detectProject(dir)
            expect(config.static).toBe(true)
          })
        )
      )
    )
  )

  it.effect("fails with ConfigInvalid on malformed portal.config.json", () =>
    withProjectDir({ "portal.config.json": JSON.stringify({ buildCommand: 42 }) }).pipe(
      Effect.flatMap((dir) =>
        withBuilder(successScript, () =>
          Effect.gen(function* () {
            const builder = yield* Builder
            const failure = yield* builder.detectProject(dir).pipe(Effect.flip)
            expect(failure._tag).toBe("ConfigInvalid")
          })
        )
      )
    )
  )

  it.effect("infers a Bun build command from package.json module", () =>
    withProjectDir({
      "package.json": JSON.stringify({ name: "acme", module: "src/index.ts" }),
      "src/index.ts": "console.log('hi')"
    }).pipe(
      Effect.flatMap((dir) =>
        withBuilder(successScript, () =>
          Effect.gen(function* () {
            const builder = yield* Builder
            const config = yield* builder.detectProject(dir)
            expect(config.name).toBe("acme")
            expect(config.buildCommand).toBe("bun build src/index.ts --outdir dist --target=bun")
            expect(config.outputDir).toBe("dist")
            expect(config.static).toBeUndefined()
          })
        )
      )
    )
  )

  it.effect("infers a Bun build command from an index.ts entrypoint", () =>
    withProjectDir({
      "package.json": JSON.stringify({ name: "acme" }),
      "index.ts": "console.log('hi')"
    }).pipe(
      Effect.flatMap((dir) =>
        withBuilder(successScript, () =>
          Effect.gen(function* () {
            const builder = yield* Builder
            const config = yield* builder.detectProject(dir)
            expect(config.buildCommand).toBe("bun build index.ts --outdir dist --target=bun")
            expect(config.outputDir).toBe("dist")
          })
        )
      )
    )
  )

  it.effect("fails with ConfigInvalid when the module entrypoint is missing", () =>
    withProjectDir({
      "package.json": JSON.stringify({ name: "acme", module: "server.ts" })
    }).pipe(
      Effect.flatMap((dir) =>
        withBuilder(successScript, () =>
          Effect.gen(function* () {
            const builder = yield* Builder
            const failure = yield* builder.detectProject(dir).pipe(Effect.flip)
            expect(failure._tag).toBe("ConfigInvalid")
          })
        )
      )
    )
  )

  it.effect("fails with ConfigInvalid when the project is not buildable", () =>
    withProjectDir({ "README.md": "nothing here" }).pipe(
      Effect.flatMap((dir) =>
        withBuilder(successScript, () =>
          Effect.gen(function* () {
            const builder = yield* Builder
            const failure = yield* builder.detectProject(dir).pipe(Effect.flip)
            expect(failure._tag).toBe("ConfigInvalid")
          })
        )
      )
    )
  )
})

describe("Builder.build", () => {
  const config = {
    name: makeProjectName("acme"),
    buildCommand: "npm run build",
    outputDir: "dist"
  }

  it.effect("runs the build command and captures its output", () =>
    withProjectDir({}).pipe(
      Effect.flatMap((dir) =>
        withBuilder(successScript, (commands) =>
          Effect.gen(function* () {
            const builder = yield* Builder
            const output = yield* builder.build(config, dir)

            expect(commands).toHaveLength(1)
            const cmd = commands[0]
            expect(cmd?.command).toBe("npm run build")
            expect(cmd?.options.cwd).toBe(dir)
            expect(cmd?.options.shell).toBe(true)
            expect(output.buildLog).toBe("building...\ndone")
            expect(resolve(output.outputDir)).toBe(resolve(dir, "dist"))
          })
        )
      )
    )
  )

  it.effect("fails with BuildFailed on a non-zero exit code", () =>
    withProjectDir({}).pipe(
      Effect.flatMap((dir) =>
        withBuilder(failureScript, () =>
          Effect.gen(function* () {
            const builder = yield* Builder
            const failure = yield* builder.build(config, dir).pipe(Effect.flip)
            expect(failure._tag).toBe("BuildFailed")
            expect(failure.exitCode).toBe(1)
            expect(failure.log).toContain("boom")
          })
        )
      )
    )
  )

  it.effect("skips the build for static projects", () =>
    withProjectDir({}).pipe(
      Effect.flatMap((dir) =>
        withBuilder(successScript, (commands) =>
          Effect.gen(function* () {
            const builder = yield* Builder
            const staticConfig = { name: makeProjectName("acme"), static: true, outputDir: "." }
            const output = yield* builder.build(staticConfig, dir)

            expect(commands).toHaveLength(0)
            expect(output.buildLog).toBe("")
            expect(resolve(output.outputDir)).toBe(resolve(dir))
          })
        )
      )
    )
  )
})

describe("Builder.packageArtifact", () => {
  it.effect("creates a gzipped tar of the output directory", () =>
    withProjectDir({
      "index.html": "<h1>hi</h1>",
      "assets/app.js": "console.log(1)"
    }).pipe(
      Effect.flatMap((dir) =>
        withBuilder(successScript, () =>
          Effect.gen(function* () {
            const builder = yield* Builder
            const dest = join(dir, "artifact.tar.gz")

            const artifactPath = yield* builder.packageArtifact("acme", dir, dest)
            expect(artifactPath).toBe(dest)

            const entries: Array<string> = []
            yield* Effect.promise(() =>
              tarList({ file: dest, onReadEntry: (entry) => entries.push(entry.path) })
            )
            expect(entries.some((p) => p.endsWith("index.html"))).toBe(true)
            expect(entries.some((p) => p.endsWith("assets/app.js"))).toBe(true)
          })
        )
      )
    )
  )

  it.effect("fails with PackageFailed when the output directory is missing", () =>
    withProjectDir({}).pipe(
      Effect.flatMap((dir) =>
        withBuilder(successScript, () =>
          Effect.gen(function* () {
            const builder = yield* Builder
            const failure = yield* builder
              .packageArtifact("acme", join(dir, "missing"), join(dir, "out.tar.gz"))
              .pipe(Effect.flip)
            expect(failure._tag).toBe("PackageFailed")
          })
        )
      )
    )
  )
})
