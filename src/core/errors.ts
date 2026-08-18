import { Schema } from "effect"

export class ProjectNotFound extends Schema.TaggedError<ProjectNotFound>()("ProjectNotFound", {
  project: Schema.NonEmptyString
}) {}

export class ConfigInvalid extends Schema.TaggedError<ConfigInvalid>()("ConfigInvalid", {
  path: Schema.NonEmptyString,
  cause: Schema.Defect()
}) {}

export class BuildFailed extends Schema.TaggedError<BuildFailed>()("BuildFailed", {
  project: Schema.NonEmptyString,
  exitCode: Schema.Int,
  log: Schema.String
}) {}

export class UploadFailed extends Schema.TaggedError<UploadFailed>()("UploadFailed", {
  project: Schema.NonEmptyString,
  deployId: Schema.NonEmptyString,
  cause: Schema.Defect()
}) {}

export class StorageError extends Schema.TaggedError<StorageError>()("StorageError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

export class DeployNotFound extends Schema.TaggedError<DeployNotFound>()("DeployNotFound", {
  deployId: Schema.NonEmptyString
}) {}

export class AliasNotFound extends Schema.TaggedError<AliasNotFound>()("AliasNotFound", {
  project: Schema.NonEmptyString,
  alias: Schema.NonEmptyString
}) {}

export class RegistryError extends Schema.TaggedError<RegistryError>()("RegistryError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

export class ServerError extends Schema.TaggedError<ServerError>()("ServerError", {
  message: Schema.String
}) {}

export type DeployError =
  | ProjectNotFound
  | ConfigInvalid
  | BuildFailed
  | UploadFailed
  | DeployNotFound
  | RegistryError