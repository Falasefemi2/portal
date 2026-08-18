import { Config, Context, Effect, Layer, Option } from "effect"

export interface RuntimeConfigService {
  readonly gcsBucket: string
  readonly googleProjectId: Option.Option<string>
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
    const gcsBucket = yield* Config.nonEmptyString("GCS_BUCKET")
    const googleProjectId = yield* Config.option(Config.string("GOOGLE_PROJECT_ID"))
    const databaseUrl = yield* Config.nonEmptyString("DATABASE_URL")
    const port = yield* Config.int("PORT").pipe(Config.withDefault(8080))
    const dataDir = yield* Config.string("DATA_DIR").pipe(Config.withDefault(".portal"))

    return RuntimeConfig.of({
      gcsBucket,
      googleProjectId,
      databaseUrl,
      port,
      dataDir
    })
  })
)