import { join, resolve, sep } from "node:path"
import { Context, Effect, FileSystem, Layer, Option } from "effect"
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { extract as tarExtract } from "tar"
import { RuntimeConfig } from "../config/runtime.js"
import { makeDeployId, makeProjectName } from "../core/model.js"
import { DeployRecord } from "../core/model.js"
import { Registry } from "../registry/registry.js"
import { Storage } from "../storage/storage.js"
import { handleApi } from "./api.js"

export interface ServerService {
  readonly handle: (pathname: string) => Effect.Effect<HttpServerResponse.HttpServerResponse, never>
}

export class Server extends Context.Service<Server, ServerService>()(
  "portal/server/Server"
) {}

export const layer = Layer.effect(
  Server,
  Effect.gen(function* () {
    const registry = yield* Registry
    const storage = yield* Storage
    const fs = yield* FileSystem.FileSystem
    const runtime = yield* RuntimeConfig

    const notFound = () => HttpServerResponse.empty().pipe(HttpServerResponse.setStatus(404))
    const internalError = () => HttpServerResponse.empty().pipe(HttpServerResponse.setStatus(500))

    const safeJoin = (root: string, rel: string): string | undefined => {
      const abs = resolve(root, rel)
      return abs === root || abs.startsWith(root + sep) ? abs : undefined
    }

    const contentTypeFor = (path: string): string => {
      const ext = path.split(".").pop()?.toLowerCase()
      switch (ext) {
        case "html":
          return "text/html"
        case "css":
          return "text/css"
        case "js":
          return "text/javascript"
        case "json":
          return "application/json"
        case "svg":
          return "image/svg+xml"
        case "png":
          return "image/png"
        case "jpg":
        case "jpeg":
          return "image/jpeg"
        case "webp":
          return "image/webp"
        case "ico":
          return "image/x-icon"
        case "txt":
          return "text/plain"
        default:
          return "application/octet-stream"
      }
    }

    const resolveRecord = Effect.fn("Server.resolveRecord")(function* (
      project: string,
      ref?: string
    ) {
      const target = ref ?? "production"
      const maybe = yield* registry.resolveAlias(makeProjectName(project), target).pipe(
        Effect.catchTag("AliasNotFound", () => registry.getDeploy(makeDeployId(target))),
        Effect.catchTag("DeployNotFound", () => Effect.void),
      )
      if (
        maybe === undefined ||
        maybe.project !== project ||
        maybe.status !== "succeeded" ||
        maybe.artifactPath === undefined
      ) {
        return Option.none()
      }
      return Option.some(maybe)
    })

    const ensureArtifact = Effect.fn("Server.ensureArtifact")(function* (
      record: DeployRecord,
      artifactPath: string
    ) {
      const cacheRoot = join(runtime.dataDir, "cache", record.project, record.deployId)
      const outDir = join(cacheRoot, "out")
      const marker = join(outDir, ".portal-extracted")

      const cached = yield* fs.exists(marker)
      if (!cached) {
        const tmpTar = join(cacheRoot, "artifact.tar.gz")
        yield* fs.makeDirectory(cacheRoot, { recursive: true })
        yield* storage.getObject(artifactPath, tmpTar)
        yield* fs.makeDirectory(outDir, { recursive: true })
        yield* Effect.tryPromise(() => tarExtract({ file: tmpTar, cwd: outDir }))
        yield* fs.writeFileString(marker, "ok")
      }
      return outDir
    })

    const handle = Effect.fn("Server.handle")(
      function* (pathname: string) {
        if (pathname === "/" || pathname === "") {
          const deploys = yield* registry.listDeploys()
          const projects = [...new Set(deploys.map((d) => d.project))]
          const body = projects.length === 0 ? "no projects deployed" : projects.join("\n")
          return HttpServerResponse.text(body, { contentType: "text/plain" })
        }
        if (pathname === "/health") {
          return HttpServerResponse.text("ok")
        }

        const segments = pathname
          .split("/")
          .filter((s) => s.length > 0)
          .map(decodeURIComponent)
        const [project, ref, ...rest] = segments
        if (project === undefined) return notFound()

        const maybeRecord = yield* resolveRecord(project, ref)
        if (Option.isNone(maybeRecord)) return notFound()
        const record = maybeRecord.value
        if (record.artifactPath === undefined) return notFound()

        const root = yield* ensureArtifact(record, record.artifactPath)

        const rel = rest.length === 0 ? "index.html" : rest.join("/")
        const abs = safeJoin(root, rel)
        if (abs === undefined) return notFound()

        const exists = yield* fs.exists(abs)
        if (!exists) return notFound()

        let target = abs
        const info = yield* fs.stat(abs)
        if (info.type === "Directory") {
          target = join(abs, "index.html")
          const hasIndex = yield* fs.exists(target)
          if (!hasIndex) return notFound()
        }

        const bytes = yield* fs.readFile(target)
        return HttpServerResponse.uint8Array(bytes, { contentType: contentTypeFor(target) })
      },
      Effect.catch((cause) =>
        Effect.logError(cause).pipe(Effect.andThen(Effect.succeed(internalError())))
      )
    )

    return Server.of({ handle })
  })
)

export const serve = Effect.fn("Server.serve")(function* () {
  const server = yield* Server
  const httpServer = yield* HttpServer.HttpServer
  const handler = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const url = new URL(request.url, "http://localhost")
    const pathname = url.pathname
    // API routes get CORS + JSON/SSE
    if (pathname.startsWith("/api/")) {
      const method = request.method
      // Preflight
      if (method === "OPTIONS") {
        return HttpServerResponse.empty({ status: 204 }).pipe(
          HttpServerResponse.setHeaders({
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          })
        )
      }
      const bodyText = yield* request.text.pipe(Effect.orElseSucceed(() => ""))
      return yield* handleApi(pathname, method, bodyText || undefined, url.searchParams)
    }
    return yield* server.handle(pathname)
  })
  return yield* httpServer.serve(handler)
})
