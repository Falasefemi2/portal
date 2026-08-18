import { layer as childProcessSpawnerLayer } from "@effect/platform-bun/BunChildProcessSpawner"
import { layer as fileSystemLayer } from "@effect/platform-bun/BunFileSystem"
import { layer as pathLayer } from "@effect/platform-bun/BunPath"
import { Context, DateTime, Effect, Layer, Redacted, Ref, Schema } from "effect"
import { Reactivity } from "effect/unstable/reactivity"
import { Migrator, SqlClient } from "effect/unstable/sql"
import type { Fragment } from "effect/unstable/sql/Statement"
import { PgClient, PgMigrator } from "@effect/sql-pg"
import { AliasNotFound, DeployNotFound, RegistryError } from "../core/errors.js"
import { AliasRecord, DeployId, DeployRecord, DeployStatus, ProjectName } from "../core/model.js"
import { RuntimeConfig } from "../config/runtime.js"

export interface CreateDeployInput {
  readonly deployId: DeployId
  readonly project: ProjectName
  readonly gitSha: string
  readonly createdAt: DateTime.Utc
}

export interface DeployPatch {
  readonly status?: DeployStatus
  readonly artifactPath?: string
  readonly buildLogRef?: string
}

export interface RegistryService {
  readonly createDeploy: (input: CreateDeployInput) => Effect.Effect<DeployRecord, RegistryError>
  readonly getDeploy: (deployId: DeployId) => Effect.Effect<DeployRecord, DeployNotFound | RegistryError>
  readonly listDeploys: (project?: ProjectName) => Effect.Effect<ReadonlyArray<DeployRecord>, RegistryError>
  readonly updateDeploy: (deployId: DeployId, patch: DeployPatch) => Effect.Effect<DeployRecord, DeployNotFound | RegistryError>
  readonly setAlias: (project: ProjectName, alias: string, deployId: DeployId) => Effect.Effect<AliasRecord, RegistryError>
  readonly resolveAlias: (project: ProjectName, alias: string) => Effect.Effect<DeployRecord, AliasNotFound | RegistryError>
}

export class Registry extends Context.Service<Registry, RegistryService>()(
  "portal/registry/Registry"
) {}

interface DeployRow {
  readonly deploy_id: string
  readonly project: string
  readonly git_sha: string
  readonly status: DeployStatus
  readonly created_at: Date
  readonly artifact_path: string | null
  readonly build_log_ref: string | null
}

const COLUMNS = "deploy_id, project, git_sha, status, created_at, artifact_path, build_log_ref"

const fromRow = (row: DeployRow): DeployRecord =>
  Schema.decodeSync(DeployRecord)({
    deployId: row.deploy_id,
    project: row.project,
    gitSha: row.git_sha,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    ...(row.artifact_path !== null ? { artifactPath: row.artifact_path } : {}),
    ...(row.build_log_ref !== null ? { buildLogRef: row.build_log_ref } : {})
  })

const registryError = (operation: string) =>
  Effect.mapError((cause: unknown) => new RegistryError({ operation, cause }))

const recordAtCreate = (input: CreateDeployInput): DeployRecord =>
  Schema.decodeSync(DeployRecord)({
    deployId: input.deployId,
    project: input.project,
    gitSha: input.gitSha,
    status: "running",
    createdAt: DateTime.toDateUtc(input.createdAt).toISOString()
  })

const recordAtUpdate = (existing: DeployRecord, patch: DeployPatch): DeployRecord => {
  const artifactPath = patch.artifactPath ?? existing.artifactPath
  const buildLogRef = patch.buildLogRef ?? existing.buildLogRef
  return Schema.decodeSync(DeployRecord)({
    deployId: existing.deployId,
    project: existing.project,
    gitSha: existing.gitSha,
    status: patch.status ?? existing.status,
    createdAt: DateTime.toDateUtc(existing.createdAt).toISOString(),
    ...(artifactPath !== undefined ? { artifactPath } : {}),
    ...(buildLogRef !== undefined ? { buildLogRef } : {})
  })
}

const aliasRecordOf = (project: ProjectName, alias: string, deployId: DeployId): AliasRecord =>
  Schema.decodeSync(AliasRecord)({ project, alias, deployId })

const migrations = (sql: SqlClient.SqlClient) =>
  Migrator.fromRecord({
    "1_init": sql`
      CREATE TABLE IF NOT EXISTS deploys (
        deploy_id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        git_sha TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
        created_at TIMESTAMPTZ NOT NULL,
        artifact_path TEXT,
        build_log_ref TEXT
      );
      CREATE TABLE IF NOT EXISTS aliases (
        project TEXT NOT NULL,
        alias TEXT NOT NULL,
        deploy_id TEXT NOT NULL REFERENCES deploys (deploy_id),
        PRIMARY KEY (project, alias)
      );
      CREATE INDEX IF NOT EXISTS deploys_project_created_at ON deploys (project, created_at DESC);
    `.pipe(Effect.asVoid)
  })

const sqlLayer = Layer.effectContext(
  Effect.gen(function* () {
    const config = yield* RuntimeConfig
    const url = Redacted.make(config.databaseUrl)
    const client = yield* PgClient.make({ url })

    yield* PgMigrator.run({ loader: migrations(client) }).pipe(
      Effect.provideService(SqlClient.SqlClient, client),
      Effect.provideService(PgClient.PgClient, client)
    )

    return Context.make(PgClient.PgClient, client).pipe(Context.add(SqlClient.SqlClient, client))
  })
).pipe(
  Layer.provide(Reactivity.layer),
  Layer.provide(fileSystemLayer),
  Layer.provide(pathLayer),
  Layer.provide(childProcessSpawnerLayer)
)

export const layer = Layer.effect(
  Registry,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const createDeploy = Effect.fn("Registry.createDeploy")(function* (input: CreateDeployInput) {
      yield* sql`
        INSERT INTO deploys (deploy_id, project, git_sha, status, created_at, artifact_path, build_log_ref)
        VALUES (${input.deployId}, ${input.project}, ${input.gitSha}, 'running', ${DateTime.toDateUtc(input.createdAt)}, NULL, NULL)
      `.pipe(registryError("Registry.createDeploy"))

      return recordAtCreate(input)
    })

    const getDeploy = Effect.fn("Registry.getDeploy")(function* (deployId: DeployId) {
      const rows = yield* sql<DeployRow>`
        SELECT ${sql.literal(COLUMNS)} FROM deploys WHERE deploy_id = ${deployId}
      `.pipe(registryError("Registry.getDeploy"))

      const row = rows[0]
      if (row === undefined) return yield* new DeployNotFound({ deployId })
      return fromRow(row)
    })

    const listDeploys = Effect.fn("Registry.listDeploys")(function* (project?: ProjectName) {
      const rows = yield* (project === undefined
        ? sql<DeployRow>`SELECT ${sql.literal(COLUMNS)} FROM deploys ORDER BY created_at DESC`
        : sql<DeployRow>`SELECT ${sql.literal(COLUMNS)} FROM deploys WHERE project = ${project} ORDER BY created_at DESC`
      ).pipe(registryError("Registry.listDeploys"))

      return rows.map(fromRow)
    })

    const updateDeploy = Effect.fn("Registry.updateDeploy")(function* (
      deployId: DeployId,
      patch: DeployPatch
    ) {
      const clauses: Array<string | Fragment> = []
      if (patch.status !== undefined) clauses.push(sql`status = ${patch.status}`)
      if (patch.artifactPath !== undefined) clauses.push(sql`artifact_path = ${patch.artifactPath}`)
      if (patch.buildLogRef !== undefined) clauses.push(sql`build_log_ref = ${patch.buildLogRef}`)
      if (clauses.length === 0) return yield* getDeploy(deployId)

      const rows = yield* sql<DeployRow>`
        UPDATE deploys SET ${sql.join(", ", false)(clauses)}
        WHERE deploy_id = ${deployId}
        RETURNING ${sql.literal(COLUMNS)}
      `.pipe(registryError("Registry.updateDeploy"))

      const row = rows[0]
      if (row === undefined) return yield* new DeployNotFound({ deployId })
      return fromRow(row)
    })

    const setAlias = Effect.fn("Registry.setAlias")(function* (
      project: ProjectName,
      alias: string,
      deployId: DeployId
    ) {
      yield* sql`
        INSERT INTO aliases (project, alias, deploy_id)
        VALUES (${project}, ${alias}, ${deployId})
        ON CONFLICT (project, alias) DO UPDATE SET deploy_id = EXCLUDED.deploy_id
      `.pipe(registryError("Registry.setAlias"))

            return aliasRecordOf(project, alias, deployId)
    })

    const resolveAlias = Effect.fn("Registry.resolveAlias")(function* (project: ProjectName, alias: string) {      const rows = yield* sql<DeployRow>`
        SELECT d.deploy_id, d.project, d.git_sha, d.status, d.created_at, d.artifact_path, d.build_log_ref
        FROM deploys d
        JOIN aliases a ON a.deploy_id = d.deploy_id
        WHERE a.project = ${project} AND a.alias = ${alias}
      `.pipe(registryError("Registry.resolveAlias"))

      const row = rows[0]
      if (row === undefined) return yield* new AliasNotFound({ project, alias })
      return fromRow(row)
    })

    return Registry.of({
      createDeploy,
      getDeploy,
      listDeploys,
      updateDeploy,
      setAlias,
      resolveAlias
    })
  })
).pipe(
  Layer.provide(sqlLayer)
)

interface State {
  readonly deploys: ReadonlyMap<string, DeployRecord>
  readonly aliases: ReadonlyMap<string, AliasRecord>
}

const aliasKey = (project: ProjectName, alias: string) => `${project}::${alias}`

export const testLayer = Layer.effect(
  Registry,
  Effect.gen(function* () {
    const state = yield* Ref.make<State>({ deploys: new Map(), aliases: new Map() })

    const createDeploy = Effect.fn("Registry.fake.createDeploy")(function* (input: CreateDeployInput) {
      const record = recordAtCreate(input)

      yield* Ref.update(state, (s) => ({
        ...s,
        deploys: new Map(s.deploys).set(input.deployId, record)
      }))

      return record
    })

    const getDeploy = Effect.fn("Registry.fake.getDeploy")(function* (deployId: DeployId) {
      const s = yield* Ref.get(state)
      const record = s.deploys.get(deployId)
      if (record === undefined) return yield* new DeployNotFound({ deployId })
      return record
    })

    const listDeploys = Effect.fn("Registry.fake.listDeploys")(function* (project?: ProjectName) {
      const s = yield* Ref.get(state)
      const records = [...s.deploys.values()]
      return records
        .filter((record) => project === undefined || record.project === project)
        .sort((a, b) => DateTime.Order(a.createdAt, b.createdAt) * -1)
    })

    const updateDeploy = Effect.fn("Registry.fake.updateDeploy")(function* (
      deployId: DeployId,
      patch: DeployPatch
    ) {
      const s = yield* Ref.get(state)
      const existing = s.deploys.get(deployId)
      if (existing === undefined) return yield* new DeployNotFound({ deployId })

      const updated = recordAtUpdate(existing, patch)

      yield* Ref.update(state, (s) => ({
        ...s,
        deploys: new Map(s.deploys).set(deployId, updated)
      }))

      return updated
    })

    const setAlias = Effect.fn("Registry.fake.setAlias")(function* (
      project: ProjectName,
      alias: string,
      deployId: DeployId
    ) {
      const aliasRecord = aliasRecordOf(project, alias, deployId)

      yield* Ref.update(state, (s) => ({
        ...s,
        aliases: new Map(s.aliases).set(aliasKey(project, alias), aliasRecord)
      }))

      return aliasRecord
    })

    const resolveAlias = Effect.fn("Registry.fake.resolveAlias")(function* (project: ProjectName, alias: string) {
      const s = yield* Ref.get(state)
      const aliasRecord = s.aliases.get(aliasKey(project, alias))
      if (aliasRecord === undefined) return yield* new AliasNotFound({ project, alias })

      const record = s.deploys.get(aliasRecord.deployId)
      if (record === undefined) return yield* new AliasNotFound({ project, alias })
      return record
    })

    return Registry.of({
      createDeploy,
      getDeploy,
      listDeploys,
      updateDeploy,
      setAlias,
      resolveAlias
    })
  })
)