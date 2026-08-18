import { Config, Context, Effect, Layer } from "effect"

export interface RuntimeConfigService {
  readonly supabaseProjectRef: string
  readonly supabaseAccessKeyId: string
  readonly supabaseSecretAccessKey: string
  readonly supabaseBucket: string
  readonly supabaseS3Region: string
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
    const supabaseProjectRef = yield* Config.nonEmptyString("SUPABASE_PROJECT_REF")
    const supabaseAccessKeyId = yield* Config.nonEmptyString("SUPABASE_S3_ACCESS_KEY_ID")
    const supabaseSecretAccessKey = yield* Config.nonEmptyString("SUPABASE_S3_SECRET_ACCESS_KEY")
    const supabaseBucket = yield* Config.nonEmptyString("SUPABASE_BUCKET")
    const supabaseS3Region = yield* Config.nonEmptyString("SUPABASE_S3_REGION")
    const databaseUrl = yield* Config.nonEmptyString("DATABASE_URL")
    const port = yield* Config.int("PORT").pipe(Config.withDefault(8080))
    const dataDir = yield* Config.string("DATA_DIR").pipe(Config.withDefault(".portal"))

    return RuntimeConfig.of({
      supabaseProjectRef,
      supabaseAccessKeyId,
      supabaseSecretAccessKey,
      supabaseBucket,
      supabaseS3Region,
      databaseUrl,
      port,
      dataDir
    })
  })
)