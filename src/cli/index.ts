import { BunRuntime } from "@effect/platform-bun"
import { layer as childProcessSpawnerLayer } from "@effect/platform-bun/BunChildProcessSpawner"
import { layer as fileSystemLayer } from "@effect/platform-bun/BunFileSystem"
import { layer as pathLayer } from "@effect/platform-bun/BunPath"
import { layer as stdioLayer } from "@effect/platform-bun/BunStdio"
import { layer as terminalLayer } from "@effect/platform-bun/BunTerminal"
import { Effect, Layer } from "effect"
import { layer as builderLayer } from "../builder/builder.js"
import { main } from "../cli/cli.js"
import { layer as runtimeConfigLayer } from "../config/runtime.js"
import { layer as deployLayer } from "../pipeline/deploy.js"
import { layer as registryLayer } from "../registry/registry.js"
import { layer as serverLayer } from "../server/server.js"
import { layer as storageLayer } from "../storage/storage.js"

const spawnerEnv = Layer.provide(childProcessSpawnerLayer, Layer.merge(fileSystemLayer, pathLayer))

const infra = Layer.mergeAll(
  fileSystemLayer,
  pathLayer,
  spawnerEnv,
  stdioLayer,
  terminalLayer,
  runtimeConfigLayer
)

const builderEnv = Layer.provide(builderLayer, Layer.merge(fileSystemLayer, spawnerEnv))

const registryEnv = Layer.provide(registryLayer, infra)

const storageEnv = Layer.provide(storageLayer, runtimeConfigLayer)

const services = Layer.mergeAll(builderEnv, registryEnv, storageEnv, infra)

const appLayers = Layer.provideMerge(
  Layer.mergeAll(deployLayer, serverLayer),
  services
)

BunRuntime.runMain(main(process.argv.slice(2)).pipe(Effect.provide(appLayers)))
