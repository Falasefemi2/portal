import { Config, Context, Effect, Layer } from "effect"

export interface RuntimeConfigService {
  readonly r2AccountId: string
  readonly r2AccessKeyId: string
  readonly r2SecretAccessKey: string
  readonly r2Bucket: string
  readonly databaseUrl: string
  readonly port: number
  readonly dataDir: string
}

export class RuntimeConfig extends Context.Service<RuntimeConfig, RuntimeConfigService>()(
  "portal/config/RuntimeConfig"
) {}

export const layer = Layer.effect(
  RuntimeConfig,
  Effect.gen(function* () {
    const r2AccountId = yield* Config.nonEmptyString("R2_ACCOUNT_ID")
    const r2AccessKeyId = yield* Config.nonEmptyString("R2_ACCESS_KEY_ID")
    const r2SecretAccessKey = yield* Config.nonEmptyString("R2_SECRET_ACCESS_KEY")
    const r2Bucket = yield* Config.nonEmptyString("R2_BUCKET")
    const databaseUrl = yield* Config.nonEmptyString("DATABASE_URL")
    const port = yield* Config.int("PORT").pipe(Config.withDefault(8080))
    const dataDir = yield* Config.string("DATA_DIR").pipe(Config.withDefault(".portal"))

    return RuntimeConfig.of({
      r2AccountId,
      r2AccessKeyId,
      r2SecretAccessKey,
      r2Bucket,
      databaseUrl,
      port,
      dataDir
    })
  })
)