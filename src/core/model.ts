import { Schema } from "effect"

export const DeployId = Schema.NonEmptyString.pipe(Schema.brand("DeployId"))
export type DeployId = Schema.Schema.Type<typeof DeployId>

export const ProjectName = Schema.NonEmptyString.pipe(Schema.brand("ProjectName"))
export type ProjectName = Schema.Schema.Type<typeof ProjectName>

export const makeDeployId = (id: string): DeployId => Schema.decodeSync(DeployId)(id)
export const makeProjectName = (name: string): ProjectName => Schema.decodeSync(ProjectName)(name)

export const DeployStatus = Schema.Literals(["running", "succeeded", "failed"])
export type DeployStatus = Schema.Schema.Type<typeof DeployStatus>

export const DeployRecord = Schema.Struct({
  deployId: DeployId,
  project: ProjectName,
  gitSha: Schema.NonEmptyString,
  status: DeployStatus,
  createdAt: Schema.DateTimeUtcFromString,
  artifactPath: Schema.optionalKey(Schema.NonEmptyString),
  buildLogRef: Schema.optionalKey(Schema.NonEmptyString)
})
export interface DeployRecord extends Schema.Schema.Type<typeof DeployRecord> {}

export const ProjectConfig = Schema.Struct({
  name: ProjectName,
  buildCommand: Schema.optionalKey(Schema.NonEmptyString),
  outputDir: Schema.optionalKey(Schema.NonEmptyString),
  static: Schema.optionalKey(Schema.Boolean)
})
export interface ProjectConfig extends Schema.Schema.Type<typeof ProjectConfig> {}

export const AliasRecord = Schema.Struct({
  project: ProjectName,
  alias: Schema.NonEmptyString,
  deployId: DeployId
})
export interface AliasRecord extends Schema.Schema.Type<typeof AliasRecord> {}