import { join } from "node:path"
import { DateTime, Effect, FileSystem, Option, Result, Schema } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { Registry } from "../registry/registry.js"
import { DeployService } from "../pipeline/deploy.js"
import type { DeployError } from "../core/errors.js"
import { DeployId, ProjectName, DeployStatus } from "../core/model.js"
import type { DeployRecord } from "../core/model.js"

interface ProjectSummary {
  readonly name: ProjectName
  readonly deployCount: number
  readonly lastDeploy?: DeployRecord
  readonly productionDeployId?: DeployId
}

interface ApiErrorBody {
  readonly _tag: string
  readonly message: string
  readonly path?: string
  readonly deployId?: string
  readonly project?: string
  readonly record?: DeployRecord
}

type ApiData =
  | ReadonlyArray<ProjectSummary>
  | ReadonlyArray<DeployRecord>
  | DeployRecord
  | ApiErrorBody
  | { readonly ok: true }
  | { readonly lines: ReadonlyArray<string>; readonly done: boolean }

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
}

const withCors = (r: HttpServerResponse.HttpServerResponse) =>
  HttpServerResponse.setHeaders(r, corsHeaders)

const json = (data: ApiData, status = 200) =>
  HttpServerResponse.json(data, { status }).pipe(Effect.map(withCors), Effect.orDie)

const text = (body: string, status = 200, contentType = "text/plain") =>
  Effect.succeed(HttpServerResponse.text(body, { status, contentType }).pipe(withCors))

const notFound = (msg = "not found") => text(msg, 404)
const badRequest = (msg: string) => text(msg, 400)
const serverError = (msg = "internal error") => text(msg, 500)

const sseResponse = (stream: ReadableStream<Uint8Array>) =>
  HttpServerResponse.raw(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...corsHeaders,
    },
  })

const closeController = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
  try {
    controller.close()
  } catch {
  }
}

const newestFirst = (a: DeployRecord, b: DeployRecord) =>
  DateTime.toEpochMillis(b.createdAt) - DateTime.toEpochMillis(a.createdAt)

const createdMs = (record: DeployRecord | undefined) =>
  record === undefined ? 0 : DateTime.toEpochMillis(record.createdAt)

const errorDetail = (error: DeployError): string => {
  switch (error._tag) {
    case "ConfigInvalid":
    case "PackageFailed":
    case "UploadFailed":
    case "RegistryError":
      return error.cause instanceof Error ? error.cause.message : String(error.cause ?? "")
    case "BuildFailed":
      return error.log
    case "DeployNotFound":
      return `deploy ${error.deployId} not found`
    case "ProjectNotFound":
      return `project ${error.project} not found`
  }
}

const RedeployBody = Schema.Struct({
  path: Schema.NonEmptyString,
})

const DeployBody = Schema.Struct({
  path: Schema.NonEmptyString,
  buildCommand: Schema.optionalKey(Schema.NonEmptyString),
})

export const handleApi = Effect.fn("Api.handle")(function* (
  pathname: string,
  method: string,
  bodyText: string | undefined,
  query: URLSearchParams
) {
  const registry = yield* Registry
  const fs = yield* FileSystem.FileSystem
  const services = yield* Effect.context<Registry | FileSystem.FileSystem>()

  if (method === "OPTIONS") {
    return yield* Effect.succeed(HttpServerResponse.empty({ status: 204 }).pipe(withCors))
  }

  if (pathname === "/api/projects" && method === "GET") {
    const deploys: ReadonlyArray<DeployRecord> = yield* registry.listDeploys().pipe(Effect.orElseSucceed(() => []))
    const byProject = new Map<ProjectName, Array<DeployRecord>>()
    for (const deploy of deploys) {
      const existing = byProject.get(deploy.project)
      if (existing === undefined) byProject.set(deploy.project, [deploy])
      else existing.push(deploy)
    }
    const projects: Array<ProjectSummary> = []
    for (const [name, list] of byProject) {
      const lastDeploy = [...list].sort(newestFirst)[0]
      const production = yield* Effect.option(registry.resolveAlias(name, "production"))
      projects.push({
        name,
        deployCount: list.length,
        lastDeploy,
        productionDeployId: Option.isSome(production) ? production.value.deployId : undefined,
      })
    }
    projects.sort((a, b) => createdMs(b.lastDeploy) - createdMs(a.lastDeploy))
    return yield* json(projects)
  }

  const mProjectDeploys = pathname.match(/^\/api\/projects\/([^/]+)\/deploys$/)
  if (mProjectDeploys && method === "GET") {
    const rawProject = decodeURIComponent(mProjectDeploys[1]!)
    const project = yield* Effect.option(Schema.decodeEffect(ProjectName)(rawProject))
    if (Option.isNone(project)) return yield* json([])
    const deploys: ReadonlyArray<DeployRecord> = yield* registry.listDeploys(project.value).pipe(
      Effect.orElseSucceed(() => [])
    )
    return yield* json([...deploys].sort(newestFirst))
  }

  const mDeploy = pathname.match(/^\/api\/deploys\/([^/]+)$/)
  if (mDeploy && method === "GET") {
    const rawId = decodeURIComponent(mDeploy[1]!)
    const deployId = yield* Effect.option(Schema.decodeEffect(DeployId)(rawId))
    if (Option.isNone(deployId)) return yield* notFound(`deploy ${rawId} not found`)
    const record = yield* Effect.option(registry.getDeploy(deployId.value))
    if (Option.isNone(record)) return yield* notFound(`deploy ${deployId.value} not found`)
    return yield* json(record.value)
  }

  const mLogs = pathname.match(/^\/api\/deploys\/([^/]+)\/logs$/)
  if (mLogs && method === "GET") {
    const rawId = decodeURIComponent(mLogs[1]!)
    const deployId = yield* Effect.option(Schema.decodeEffect(DeployId)(rawId))
    if (Option.isNone(deployId)) return yield* notFound(`deploy ${rawId} not found`)
    const id = deployId.value
    const record = yield* Effect.option(registry.getDeploy(id))
    if (Option.isNone(record)) return yield* notFound(`deploy ${id} not found`)
    const logRef = record.value.buildLogRef

    const useSse = query.get("sse") !== "0"
    if (!useSse) {
      if (logRef === undefined) return yield* json({ lines: [], done: true })
      const content = yield* fs.readFileString(logRef).pipe(Effect.orElseSucceed(() => ""))
      return HttpServerResponse.text(content, { status: 200, contentType: "text/plain" }).pipe(withCors)
    }

    const encoder = new TextEncoder()
    let logTimer: ReturnType<typeof setTimeout> | undefined
    let logClosed = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const finish = () => {
          controller.enqueue(encoder.encode(`event: done\ndata: {}\n\n`))
          closeController(controller)
          logClosed = true
        }
        if (logRef === undefined) {
          finish()
          return
        }
        let offset = 0
        const tick = (): void => {
          if (logClosed) return
          void Effect.runPromiseWith(services)(
            Effect.gen(function* () {
              const exists = yield* fs.exists(logRef).pipe(Effect.orElseSucceed(() => false))
              if (!exists) {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ line: "[portal] no log yet", at: new Date().toISOString() })}\n\n`)
                )
                logTimer = setTimeout(finish, 400)
                return
              }
              const content = yield* fs.readFileString(logRef).pipe(Effect.orElseSucceed(() => ""))
              const lines = content.split("\n")
              while (offset < lines.length) {
                const line = lines[offset]!
                if (line.length > 0 || offset < lines.length - 1) {
                  controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify({ line, at: new Date().toISOString() })}\n\n`)
                  )
                }
                offset++
              }
              const current = yield* Effect.option(registry.getDeploy(id))
              const status = Option.isSome(current) ? current.value.status : undefined
              if (status !== undefined && status !== "running" && offset >= lines.length) {
                finish()
                return
              }
              if (!logClosed) logTimer = setTimeout(tick, 600)
            })
          ).catch(() => {})
        }
        tick()
      },
      cancel() {
        logClosed = true
        if (logTimer !== undefined) clearTimeout(logTimer)
      },
    })
    return sseResponse(stream)
  }

  const mEvents = pathname.match(/^\/api\/deploys\/([^/]+)\/events$/)
  if (mEvents && method === "GET") {
    const rawId = decodeURIComponent(mEvents[1]!)
    const deployId = yield* Effect.option(Schema.decodeEffect(DeployId)(rawId))
    if (Option.isNone(deployId)) return yield* notFound(`deploy ${rawId} not found`)
    const id = deployId.value
    const record = yield* Effect.option(registry.getDeploy(id))
    if (Option.isNone(record)) return yield* notFound(`deploy ${id} not found`)

    const encoder = new TextEncoder()
    let previousStatus: DeployStatus = record.value.status
    let interval: ReturnType<typeof setInterval> | undefined
    let closing = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: string, payload: string) => {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${payload}\n\n`))
        }
        send("status", JSON.stringify({ status: previousStatus, at: new Date().toISOString() }))
        interval = setInterval(() => {
          if (closing) return
          void Effect.runPromiseWith(services)(
            Effect.gen(function* () {
              const current = yield* Effect.option(registry.getDeploy(id))
              if (Option.isNone(current)) return
              const status = current.value.status
              if (status !== previousStatus) {
                previousStatus = status
                send("status", JSON.stringify({ status, at: new Date().toISOString() }))
              } else {
                send("ping", JSON.stringify({ at: new Date().toISOString() }))
              }
              if (status !== "running") {
                clearInterval(interval)
                setTimeout(() => {
                  if (closing) return
                  closing = true
                  send("done", "{}")
                  closeController(controller)
                }, 900)
              }
            })
          ).catch(() => {})
        }, 1000)
      },
      cancel() {
        closing = true
        if (interval !== undefined) clearInterval(interval)
      },
    })
    return sseResponse(stream)
  }

  const mPromote = pathname.match(/^\/api\/deploys\/([^/]+)\/promote$/)
  if (mPromote && method === "POST") {
    const rawId = decodeURIComponent(mPromote[1]!)
    const deployId = yield* Effect.option(Schema.decodeEffect(DeployId)(rawId))
    if (Option.isNone(deployId)) return yield* notFound(`deploy ${rawId} not found`)
    const record = yield* Effect.option(registry.getDeploy(deployId.value))
    if (Option.isNone(record)) return yield* notFound(`deploy ${deployId.value} not found`)
    if (record.value.status !== "succeeded") return yield* text("only succeeded deploys can be promoted", 409)
    yield* registry.setAlias(record.value.project, "production", record.value.deployId).pipe(Effect.ignore)
    return yield* json({ ok: true })
  }

  const mRedeploy = pathname.match(/^\/api\/deploys\/([^/]+)\/redeploy$/)
  if (mRedeploy && method === "POST") {
    const rawId = decodeURIComponent(mRedeploy[1]!)
    const deployId = yield* Effect.option(Schema.decodeEffect(DeployId)(rawId))
    if (Option.isNone(deployId)) return yield* notFound(`deploy ${rawId} not found`)
    const record = yield* Effect.option(registry.getDeploy(deployId.value))
    if (Option.isNone(record)) return yield* notFound(`deploy ${deployId.value} not found`)
    const errorMessage = "redeploy requires { path } to local repo or github url"
    if (bodyText === undefined) return yield* badRequest(errorMessage)
    const parsedBody = yield* Effect.option(Effect.tryPromise(async () => JSON.parse(bodyText)))
    if (Option.isNone(parsedBody)) return yield* badRequest(errorMessage)
    const body = yield* Effect.option(Schema.decodeEffect(RedeployBody)(parsedBody.value))
    if (Option.isNone(body)) return yield* badRequest(errorMessage)
    const redeployPath = body.value.path
    const deployService = yield* Effect.option(DeployService)
    if (Option.isNone(deployService)) return yield* serverError("deploy service not available")
    const outcome = yield* Effect.result(deployService.value.deploy(redeployPath))
    if (Result.isSuccess(outcome)) return yield* json(outcome.success)
    yield* Effect.logError(outcome.failure)
    {
      const deploys: ReadonlyArray<DeployRecord> = yield* registry.listDeploys().pipe(Effect.orElseSucceed(() => []))
      const newest = [...deploys].sort(newestFirst)[0]
      return yield* HttpServerResponse.json(
        {
          _tag: outcome.failure._tag,
          message: errorDetail(outcome.failure),
          path: redeployPath,
          deployId: newest?.deployId,
          project: newest?.project,
          record: newest,
        },
        { status: 400 }
      ).pipe(Effect.map(withCors), Effect.orDie)
    }
  }

  if (pathname === "/api/deploy" && method === "POST") {
    if (bodyText === undefined) return yield* badRequest("missing body: { path }")
    const parsedBody = yield* Effect.option(Effect.tryPromise(async () => JSON.parse(bodyText)))
    if (Option.isNone(parsedBody)) return yield* badRequest(`invalid JSON: ${bodyText.slice(0, 200)}`)
    const payload = yield* Effect.option(Schema.decodeEffect(DeployBody)(parsedBody.value))
    if (Option.isNone(payload)) return yield* badRequest("missing path")
    const deployPath = payload.value.path
    const deployService = yield* Effect.option(DeployService)
    if (Option.isNone(deployService)) return yield* serverError("deploy service not available")
    if (payload.value.buildCommand !== undefined) {
      const configPath = join(deployPath, "portal.config.json")
      const exists = yield* fs.exists(configPath).pipe(Effect.orElseSucceed(() => false))
      if (!exists) {
        yield* fs.writeFileString(
          configPath,
          JSON.stringify({ buildCommand: payload.value.buildCommand }, null, 2)
        ).pipe(Effect.ignore)
      }
    }
    const outcome = yield* Effect.result(deployService.value.deploy(deployPath))
    if (Result.isSuccess(outcome)) return yield* json(outcome.success)
    yield* Effect.logError(outcome.failure)
    {
      const deploys: ReadonlyArray<DeployRecord> = yield* registry.listDeploys().pipe(Effect.orElseSucceed(() => []))
      const newest = [...deploys].sort(newestFirst)[0]
      return yield* HttpServerResponse.json(
        {
          _tag: outcome.failure._tag,
          message: errorDetail(outcome.failure),
          path: deployPath,
          deployId: newest?.deployId,
          project: newest?.project,
          record: newest,
        },
        { status: 400 }
      ).pipe(Effect.map(withCors), Effect.orDie)
    }
  }

  if (pathname === "/api/health" && method === "GET") {
    return yield* json({ ok: true })
  }

  return yield* notFound(`api ${method} ${pathname} not found`)
})
