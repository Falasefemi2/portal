import { describe, expect, it } from "@effect/vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Storage, testLayer } from "./storage.js"

const withStorage = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provide(effect, testLayer)

const withTempDir = <A, E, R>(effect: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "portal-storage-test-"))),
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore)
  ).pipe(
    Effect.flatMap(effect)
  )

describe("Storage", () => {
  it.effect("round-trips an object through put and get", () =>
    withStorage(
      withTempDir((dir) =>
        Effect.gen(function* () {
          const storage = yield* Storage
          const src = join(dir, "src.bin")
          const dest = join(dir, "nested", "dest.bin")
          yield* Effect.promise(() => writeFile(src, Buffer.from("hello portal")))

          yield* storage.putObject("acme/dep-1/artifact.tar.gz", src)
          yield* storage.getObject("acme/dep-1/artifact.tar.gz", dest)

          const contents = yield* Effect.promise(() => readFile(dest))
          expect(contents.toString()).toBe("hello portal")
        })
      )
    )
  )

  it.effect("lists versions under a prefix", () =>
    withStorage(
      withTempDir((dir) =>
        Effect.gen(function* () {
          const storage = yield* Storage
          const src = join(dir, "a.bin")
          yield* Effect.promise(() => writeFile(src, Buffer.from("x")))

          yield* storage.putObject("acme/dep-1/artifact.tar.gz", src)
          yield* storage.putObject("acme/dep-2/artifact.tar.gz", src)
          yield* storage.putObject("beta/dep-1/artifact.tar.gz", src)

          const versions = yield* storage.listVersions("acme/")
          expect(versions).toEqual(["acme/dep-1/artifact.tar.gz", "acme/dep-2/artifact.tar.gz"])
        })
      )
    )
  )

  it.effect("deletes an object", () =>
    withStorage(
      withTempDir((dir) =>
        Effect.gen(function* () {
          const storage = yield* Storage
          const src = join(dir, "a.bin")
          yield* Effect.promise(() => writeFile(src, Buffer.from("x")))

          yield* storage.putObject("acme/dep-1/artifact.tar.gz", src)
          yield* storage.deleteObject("acme/dep-1/artifact.tar.gz")

          const versions = yield* storage.listVersions("acme/")
          expect(versions).toEqual([])
        })
      )
    )
  )

  it.effect("fails with StorageError when getting a missing object", () =>
    withStorage(
      withTempDir((dir) =>
        Effect.gen(function* () {
          const storage = yield* Storage

          const failure = yield* storage
            .getObject("acme/dep-1/artifact.tar.gz", join(dir, "dest.bin"))
            .pipe(Effect.flip)

          expect(failure._tag).toBe("StorageError")
        })
      )
    )
  )
})