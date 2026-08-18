import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect } from "effect"
import { makeDeployId, makeProjectName } from "../core/model.js"
import { Registry, testLayer } from "./registry.js"

const project = makeProjectName("acme")
const otherProject = makeProjectName("beta")
const deployId1 = makeDeployId("dep-1")
const deployId2 = makeDeployId("dep-2")

const at = DateTime.fromDateUnsafe(new Date("2026-08-18T00:00:00Z"))
const nextDay = DateTime.fromDateUnsafe(new Date("2026-08-19T00:00:00Z"))

const withRegistry = <A, E>(effect: Effect.Effect<A, E, Registry>) =>
  Effect.provide(effect, testLayer)

describe("Registry", () => {
  it.effect("creates and fetches a deploy", () =>
    withRegistry(
      Effect.gen(function* () {
        const registry = yield* Registry

        const created = yield* registry.createDeploy({
          deployId: deployId1,
          project,
          gitSha: "abc123",
          createdAt: at
        })
        const fetched = yield* registry.getDeploy(deployId1)

        expect(fetched).toEqual(created)
        expect(fetched.status).toBe("running")
        expect(fetched.project).toBe(project)
        expect(fetched.gitSha).toBe("abc123")
      })
    )
  )

  it.effect("fails with DeployNotFound for an unknown deploy", () =>
    withRegistry(
      Effect.gen(function* () {
        const registry = yield* Registry

        const failure = yield* registry.getDeploy(makeDeployId("missing")).pipe(Effect.flip)

        expect(failure._tag).toBe("DeployNotFound")
      })
    )
  )

  it.effect("updates status and artifact references", () =>
    withRegistry(
      Effect.gen(function* () {
        const registry = yield* Registry

        yield* registry.createDeploy({ deployId: deployId1, project, gitSha: "abc123", createdAt: at })

        const updated = yield* registry.updateDeploy(deployId1, {
          status: "succeeded",
          artifactPath: "gs://bucket/acme/dep-1/artifact.tar.gz",
          buildLogRef: "gs://bucket/acme/dep-1/build.log"
        })

        expect(updated.status).toBe("succeeded")
        expect(updated.artifactPath).toBe("gs://bucket/acme/dep-1/artifact.tar.gz")
        expect(updated.buildLogRef).toBe("gs://bucket/acme/dep-1/build.log")
      })
    )
  )

  it.effect("lists deploys newest first and filters by project", () =>
    withRegistry(
      Effect.gen(function* () {
        const registry = yield* Registry

        yield* registry.createDeploy({ deployId: deployId1, project, gitSha: "abc123", createdAt: at })
        yield* registry.createDeploy({ deployId: deployId2, project, gitSha: "def456", createdAt: nextDay })

        const all = yield* registry.listDeploys()
        expect(all.map((d) => d.deployId)).toEqual([deployId2, deployId1])

        const forProject = yield* registry.listDeploys(project)
        expect(forProject.length).toBe(2)

        const forOther = yield* registry.listDeploys(otherProject)
        expect(forOther.length).toBe(0)
      })
    )
  )

  it.effect("resolves aliases and upserts on re-assignment", () =>
    withRegistry(
      Effect.gen(function* () {
        const registry = yield* Registry

        yield* registry.createDeploy({ deployId: deployId1, project, gitSha: "abc123", createdAt: at })
        yield* registry.createDeploy({ deployId: deployId2, project, gitSha: "def456", createdAt: at })

        yield* registry.setAlias(project, "production", deployId1)
        const resolved = yield* registry.resolveAlias(project, "production")
        expect(resolved.deployId).toBe(deployId1)

        yield* registry.setAlias(project, "production", deployId2)
        const reResolved = yield* registry.resolveAlias(project, "production")
        expect(reResolved.deployId).toBe(deployId2)
      })
    )
  )

  it.effect("fails with AliasNotFound for an unknown alias", () =>
    withRegistry(
      Effect.gen(function* () {
        const registry = yield* Registry

        const failure = yield* registry.resolveAlias(project, "production").pipe(Effect.flip)

        expect(failure._tag).toBe("AliasNotFound")
      })
    )
  )
})