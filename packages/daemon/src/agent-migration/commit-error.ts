/** Why the target refused to keep a chunk or place a bundle; the code names the cause. */
export type AgentMigrationCommitErrorCode =
  | "chunk_digest_mismatch"
  | "chunks_missing"
  | "bundle_digest_mismatch"
  | "manifest_mismatch"
  | "entry_too_large"
  | "unsafe_path"
  | "unsafe_link"
  | "reserved_path"
  | "unsupported_entry"
  | "workspace_in_use"
  | "workspace_invalid"
  | "workspace_already_exists"
  | "backup_conflict"
  | "backup_copy_mismatch"
  | "insufficient_disk";

export class AgentMigrationCommitError extends Error {
  constructor(
    readonly code: AgentMigrationCommitErrorCode,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "AgentMigrationCommitError";
  }
}
