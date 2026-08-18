import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { Context, Effect, Layer, Ref } from "effect"
import { StorageError } from "../core/errors.js"
import { RuntimeConfig } from "../config/runtime.js"

export interface StorageService {
  readonly putObject: (key: string, sourcePath: string) => Effect.Effect<void, StorageError>
  readonly getObject: (key: string, destPath: string) => Effect.Effect<void, StorageError>
  readonly listVersions: (prefix: string) => Effect.Effect<ReadonlyArray<string>, StorageError>
  readonly deleteObject: (key: string) => Effect.Effect<void, StorageError>
}

export class Storage extends Context.Service<Storage, StorageService>()(
  "portal/storage/Storage"
) {}

export const layer = Layer.effect(
  Storage,
  Effect.gen(function* () {
    const config = yield* RuntimeConfig
    const client = new S3Client({
      endpoint: `https://${config.supabaseProjectRef}.supabase.co/storage/v1/s3`,
      region: config.supabaseS3Region,
      credentials: {
        accessKeyId: config.supabaseAccessKeyId,
        secretAccessKey: config.supabaseSecretAccessKey
      },
      forcePathStyle: true,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED"
    })

    const putObject = Effect.fn("Storage.putObject")(function* (key: string, sourcePath: string) {
      yield* Effect.tryPromise({
        try: async () => {
          const body = await readFile(sourcePath)
          await client.send(new PutObjectCommand({ Bucket: config.supabaseBucket, Key: key, Body: body }))
        },
        catch: (cause) => new StorageError({ operation: "Storage.putObject", cause })
      })
    })

    const getObject = Effect.fn("Storage.getObject")(function* (key: string, destPath: string) {
      yield* Effect.tryPromise({
        try: async () => {
          const result = await client.send(new GetObjectCommand({ Bucket: config.supabaseBucket, Key: key }))
          if (result.Body === undefined) {
            throw new Error("empty response body")
          }
          const bytes = await result.Body.transformToByteArray()
          await mkdir(dirname(destPath), { recursive: true })
          await writeFile(destPath, bytes)
        },
        catch: (cause) => new StorageError({ operation: "Storage.getObject", cause })
      })
    })

    const listVersions = Effect.fn("Storage.listVersions")(function* (prefix: string) {
      const result = yield* Effect.tryPromise({
        try: () => client.send(new ListObjectsV2Command({ Bucket: config.supabaseBucket, Prefix: prefix })),
        catch: (cause) => new StorageError({ operation: "Storage.listVersions", cause })
      })

      return (result.Contents ?? []).flatMap((object) => (object.Key === undefined ? [] : [object.Key]))
    })

    const deleteObject = Effect.fn("Storage.deleteObject")(function* (key: string) {
      yield* Effect.tryPromise({
        try: () => client.send(new DeleteObjectCommand({ Bucket: config.supabaseBucket, Key: key })),
        catch: (cause) => new StorageError({ operation: "Storage.deleteObject", cause })
      })
    })

    return Storage.of({ putObject, getObject, listVersions, deleteObject })
  })
)

export const testLayer = Layer.effect(
  Storage,
  Effect.gen(function* () {
    const objects = yield* Ref.make<ReadonlyMap<string, Uint8Array>>(new Map())

    const putObject = Effect.fn("Storage.fake.putObject")(function* (key: string, sourcePath: string) {
      const bytes = yield* Effect.tryPromise({
        try: () => readFile(sourcePath),
        catch: (cause) => new StorageError({ operation: "Storage.fake.putObject", cause })
      })

      yield* Ref.update(objects, (m) => new Map(m).set(key, bytes))
    })

    const getObject = Effect.fn("Storage.fake.getObject")(function* (key: string, destPath: string) {
      const bytes = yield* Ref.get(objects).pipe(Effect.map((m) => m.get(key)))

      if (bytes === undefined) {
        return yield* new StorageError({
          operation: "Storage.fake.getObject",
          cause: new Error(`object not found: ${key}`)
        })
      }

      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(destPath), { recursive: true })
          await writeFile(destPath, bytes)
        },
        catch: (cause) => new StorageError({ operation: "Storage.fake.getObject", cause })
      })
    })

    const listVersions = Effect.fn("Storage.fake.listVersions")(function* (prefix: string) {
      const m = yield* Ref.get(objects)
      return [...m.keys()].filter((key) => key.startsWith(prefix)).sort()
    })

    const deleteObject = Effect.fn("Storage.fake.deleteObject")(function* (key: string) {
      yield* Ref.update(objects, (m) => {
        const next = new Map(m)
        next.delete(key)
        return next
      })
    })

    return Storage.of({ putObject, getObject, listVersions, deleteObject })
  })
)