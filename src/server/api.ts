import { join } from "node:path"
import { Effect, FileSystem } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { Registry } from "../registry/registry.js"
import { DeployService } from "../pipeline/deploy.js"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
}

const withCors = (r: HttpServerResponse.HttpServerResponse) =>
  HttpServerResponse.setHeaders(r, corsHeaders)

const json = (body: unknown, status = 200) =>
  HttpServerResponse.json(body, { status }).pipe(Effect.map(withCors), Effect.orDie)

const text = (body: string, status = 200, contentType = "text/plain") =>
  Effect.succeed(HttpServerResponse.text(body, { status, contentType }).pipe(withCors))

const notFound = (msg = "not found") => text(msg, 404)
const badRequest = (msg: string) => text(msg, 400)
const serverError = (msg = "internal error") => text(msg, 500)

export const handleApi = Effect.fn("Api.handle")(function* (
  pathname: string,
  method: string,
  bodyText: string | undefined,
  query: URLSearchParams
) {
  const registry = yield* Registry
  const fs = yield* FileSystem.FileSystem

  if (method === "OPTIONS") {
    return HttpServerResponse.empty({ status: 204 }).pipe(withCors)
  }

  if (pathname === "/api/projects" && method === "GET") {
    const deploys = yield* registry.listDeploys().pipe(Effect.orElseSucceed(() => [] as never))
    const byProject = new Map<string, typeof deploys>()
    for (const d of deploys) {
      const list = byProject.get(d.project)
      if (list) (list as unknown as Array<(typeof deploys)[number]>).push(d)
      else byProject.set(d.project, [d])
    }
    const projects: Array<{
      name: string
      deployCount: number
      lastDeploy?: (typeof deploys)[number]
      productionDeployId?: string
    }> = []
    for (const [name, list] of byProject) {
      const sorted = [...list].sort(
        (a, b) => +new Date(b.createdAt as unknown as string) - +new Date(a.createdAt as unknown as string)
      )
      const last = sorted[0]
      const prod = yield* registry
        .resolveAlias(name as never, "production")
        .pipe(Effect.catchTags({ AliasNotFound: () => Effect.succeed(undefined), RegistryError: () => Effect.succeed(undefined) }))
      projects.push({
        name,
        deployCount: list.length,
        lastDeploy: last,
        productionDeployId: prod?.deployId as string | undefined,
      })
    }
    projects.sort((a, b) => {
      const at = a.lastDeploy ? +new Date(a.lastDeploy.createdAt as unknown as string) : 0
      const bt = b.lastDeploy ? +new Date(b.lastDeploy.createdAt as unknown as string) : 0
      return bt - at
    })
    return yield* json(projects)
  }

  const mProjectDeploys = pathname.match(/^\/api\/projects\/([^/]+)\/deploys$/)
  if (mProjectDeploys && method === "GET") {
    const project = decodeURIComponent(mProjectDeploys[1]!)
    const rows = yield* registry.listDeploys(project as never).pipe(Effect.orElseSucceed(() => [] as never))
    const filtered = [...rows].sort(
      (a, b) => +new Date(b.createdAt as unknown as string) - +new Date(a.createdAt as unknown as string)
    )
    return yield* json(filtered)
  }

  const mDeploy = pathname.match(/^\/api\/deploys\/([^/]+)$/)
  if (mDeploy && method === "GET") {
    const id = decodeURIComponent(mDeploy[1]!)
    const rec = yield* registry.getDeploy(id as never).pipe(
      Effect.catchTags({ DeployNotFound: () => Effect.succeed(undefined), RegistryError: () => Effect.succeed(undefined) })
    )
    if (!rec) return yield* notFound(`deploy ${id} not found`)
    return yield* json(rec)
  }

  const mLogs = pathname.match(/^\/api\/deploys\/([^/]+)\/logs$/)
  if (mLogs && method === "GET") {
    const id = decodeURIComponent(mLogs[1]!)
    const rec = yield* registry.getDeploy(id as never).pipe(
      Effect.catchTags({ DeployNotFound: () => Effect.succeed(undefined), RegistryError: () => Effect.succeed(undefined) })
    )
    if (!rec) return yield* notFound(`deploy ${id} not found`)
    const ref = (rec as { buildLogRef?: string }).buildLogRef
    if (!ref) {
      // SSE expects stream, but if no log return done immediately
      if (query.get("sse") !== "0") {
        const enc = new TextEncoder()
        const rs = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode(`event: done\ndata: {}\n\n`))
            c.close()
          },
        })
        return HttpServerResponse.raw(rs as unknown as Uint8Array, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            ...corsHeaders,
          },
        })
      }
      return yield* json({ lines: [], done: true })
    }

    const useSse = query.get("sse") !== "0"
    if (useSse) {
      const logPath = ref
      const encoder = new TextEncoder()
      const rs = new ReadableStream<Uint8Array>({
        start(controller) {
          let offset = 0
          let closed = false
          let timer: ReturnType<typeof setTimeout> | undefined

          const tick = () => {
            if (closed) return
            Effect.runPromise(
              Effect.gen(function* () {
                const exists = yield* fs.exists(logPath).pipe(Effect.orElseSucceed(() => false))
                if (!exists) {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ line: "[portal] no log yet", at: new Date().toISOString() })}\n\n`))
                  setTimeout(() => {
                    if (!closed) {
                      controller.enqueue(encoder.encode(`event: done\ndata: {}\n\n`))
                      try { controller.close() } catch {}
                      closed = true
                    }
                  }, 400)
                  return
                }
                const txt = yield* fs.readFileString(logPath).pipe(Effect.orElseSucceed(() => ""))
                const lines = txt.split("\n")
                while (offset < lines.length) {
                  const line = lines[offset]!
                  if (line.length > 0 || offset < lines.length - 1) {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ line, at: new Date().toISOString() })}\n\n`))
                  }
                  offset++
                }
                const cur = yield* registry.getDeploy(id as never).pipe(
                  Effect.catchTags({ DeployNotFound: () => Effect.succeed(undefined), RegistryError: () => Effect.succeed(undefined) })
                )
                const status = (cur as { status?: string } | undefined)?.status
                if (status && status !== "running" && offset >= lines.length) {
                  controller.enqueue(encoder.encode(`event: done\ndata: {}\n\n`))
                  try { controller.close() } catch {}
                  closed = true
                  return
                }
                if (!closed) timer = setTimeout(tick, 600)
              }).pipe(Effect.catch(() => Effect.void))
            )
          }
          tick()
          // cleanup on cancel handled via return not needed for portal demo
          void timer
        },
        cancel() {},
      })
      return HttpServerResponse.raw(rs as unknown as Uint8Array, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          ...corsHeaders,
        },
      })
    }

    const content = yield* fs.readFileString(ref).pipe(Effect.orElseSucceed(() => ""))
    return HttpServerResponse.text(content, { status: 200, contentType: "text/plain" }).pipe(withCors)
  }

  const mEvents = pathname.match(/^\/api\/deploys\/([^/]+)\/events$/)
  if (mEvents && method === "GET") {
    const id = decodeURIComponent(mEvents[1]!)
    const rec = yield* registry.getDeploy(id as never).pipe(
      Effect.catchTags({ DeployNotFound: () => Effect.succeed(undefined), RegistryError: () => Effect.succeed(undefined) })
    )
    if (!rec) return yield* notFound(`deploy ${id} not found`)
    const encoder = new TextEncoder()
    const initialStatus = (rec as { status: string }).status
    const rs = new ReadableStream<Uint8Array>({
      start(controller) {
        let prev = initialStatus
        controller.enqueue(encoder.encode(`event: status\ndata: ${JSON.stringify({ status: prev, at: new Date().toISOString() })}\n\n`))
        let closed = false
        const iv = setInterval(() => {
          if (closed) return
          Effect.runPromise(
            Effect.gen(function* () {
              const cur = yield* registry.getDeploy(id as never).pipe(
                Effect.catchTags({ DeployNotFound: () => Effect.succeed(undefined), RegistryError: () => Effect.succeed(undefined) })
              )
              const curStatus = (cur as { status?: string } | undefined)?.status
              if (!curStatus) return
              if (curStatus !== prev) {
                prev = curStatus
                controller.enqueue(encoder.encode(`event: status\ndata: ${JSON.stringify({ status: curStatus, at: new Date().toISOString() })}\n\n`))
              } else {
                controller.enqueue(encoder.encode(`event: ping\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`))
              }
              if (curStatus !== "running") {
                setTimeout(() => {
                  if (!closed) {
                    controller.enqueue(encoder.encode(`event: done\ndata: {}\n\n`))
                    try { controller.close() } catch {}
                    closed = true
                    clearInterval(iv)
                  }
                }, 900)
                clearInterval(iv)
              }
            }).pipe(Effect.catch(() => Effect.void))
          )
        }, 1000)
        // allow GC
        void closed
      },
    })
    return HttpServerResponse.raw(rs as unknown as Uint8Array, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...corsHeaders,
      },
    })
  }

  const mPromote = pathname.match(/^\/api\/deploys\/([^/]+)\/promote$/)
  if (mPromote && method === "POST") {
    const id = decodeURIComponent(mPromote[1]!)
    const rec = yield* registry.getDeploy(id as never).pipe(
      Effect.catchTags({ DeployNotFound: () => Effect.succeed(undefined), RegistryError: () => Effect.succeed(undefined) })
    )
    if (!rec) return yield* notFound(`deploy ${id} not found`)
    if ((rec as { status: string }).status !== "succeeded") return yield* text("only succeeded deploys can be promoted", 409)
    yield* registry.setAlias((rec as { project: string }).project as never, "production", id as never).pipe(Effect.orElseSucceed(() => undefined))
    return yield* json({ ok: true })
  }

  const mRedeploy = pathname.match(/^\/api\/deploys\/([^/]+)\/redeploy$/)
  if (mRedeploy && method === "POST") {
    const id = decodeURIComponent(mRedeploy[1]!)
    const rec = yield* registry.getDeploy(id as never).pipe(
      Effect.catchTags({ DeployNotFound: () => Effect.succeed(undefined), RegistryError: () => Effect.succeed(undefined) })
    )
    if (!rec) return yield* notFound(`deploy ${id} not found`)
    let redeployPath: string | undefined
    if (bodyText) {
      try {
        const parsed = JSON.parse(bodyText) as { path?: string }
        redeployPath = parsed.path
      } catch {}
    }
    if (!redeployPath) return yield* badRequest("redeploy requires { path } to local repo or github url")
    const deployService = yield* DeployService.pipe(Effect.orElseSucceed(() => undefined))
    if (!deployService) return yield* serverError("deploy service not available")
    const r = yield* deployService.deploy(redeployPath).pipe(
      Effect.map((record) => ({ ok: true as const, record })),
      Effect.catch((err) =>
        Effect.gen(function* () {
          yield* Effect.logError(err)
          const all = yield* registry.listDeploys().pipe(Effect.orElseSucceed(() => [] as never))
          const newest = [...all].sort((a, b) => +new Date(b.createdAt as unknown as string) - +new Date(a.createdAt as unknown as string))[0]
          return { ok: false as const, err, record: newest }
        })
      )
    )
    if (r.ok) return yield* json(r.record)
    const tag = (r.err as { _tag?: string })._tag ?? "DeployError"
    const rawCause = (r.err as { cause?: unknown }).cause
    const detail = rawCause instanceof Error ? rawCause.message : rawCause != null ? String(rawCause) : undefined
    const msg = detail || (r.err as { message?: string }).message || String(r.err)
    return yield* HttpServerResponse.json({ _tag: tag, message: msg, path: redeployPath, deployId: r.record?.deployId, project: r.record?.project, record: r.record }, { status: 400 }).pipe(
      Effect.map(withCors),
      Effect.orDie
    )
  }

  if (pathname === "/api/deploy" && method === "POST") {
    if (!bodyText) return yield* badRequest("missing body: { path }")
    let payload: { path?: string; buildCommand?: string }
    try {
      payload = JSON.parse(bodyText) as typeof payload
    } catch {
      return yield* badRequest(`invalid JSON: ${bodyText.slice(0, 200)}`)
    }
    const deployPath = payload.path
    if (!deployPath || typeof deployPath !== "string") return yield* badRequest("missing path")
    const deployService = yield* DeployService.pipe(Effect.orElseSucceed(() => undefined))
    if (!deployService) return yield* serverError("deploy service not available")
    if (payload.buildCommand) {
      const cfgPath = join(deployPath, "portal.config.json")
      const exists = yield* fs.exists(cfgPath).pipe(Effect.orElseSucceed(() => false))
      if (!exists) {
        yield* fs.writeFileString(cfgPath, JSON.stringify({ buildCommand: payload.buildCommand }, null, 2)).pipe(Effect.orElseSucceed(() => undefined))
      }
    }
    // Run synchronously so failures (ConfigInvalid, BuildFailed) are surfaced to the UI with a persisted failed deploy
    const result = yield* deployService.deploy(deployPath).pipe(
      Effect.map((record) => ({ ok: true as const, record })),
      Effect.catch((err) =>
        Effect.gen(function* () {
          yield* Effect.logError(err)
          const all = yield* registry.listDeploys().pipe(Effect.orElseSucceed(() => [] as never))
          const newest = [...all].sort((a, b) => +new Date(b.createdAt as unknown as string) - +new Date(a.createdAt as unknown as string))[0]
          return { ok: false as const, err, record: newest }
        })
      )
    )
    if (result.ok) return yield* json(result.record)
    const errTag = (result.err as { _tag?: string })._tag ?? "DeployError"
    const rawCause = (result.err as { cause?: unknown }).cause
    const detail = rawCause instanceof Error ? rawCause.message : rawCause != null ? String(rawCause) : undefined
    const errMsg = detail || (result.err as { message?: string }).message || String(result.err)
    // Return the failed deploy so the frontend can link to /deploys/:id and show logs
    return yield* HttpServerResponse.json(
      { _tag: errTag, message: errMsg, path: deployPath, deployId: result.record?.deployId, project: result.record?.project, record: result.record },
      { status: 400 }
    ).pipe(Effect.map(withCors), Effect.orDie)
  }

  if (pathname === "/api/health" && method === "GET") {
    return yield* json({ ok: true })
  }

  return yield* notFound(`api ${method} ${pathname} not found`)
})
