/** Why a chunk transfer stopped before it finished; the code names the cause. */
export type AgentMigrationTransferErrorCode =
  | "lease_expired"
  | "aborted"
  | "manifest_missing"
  | "switch_unknown";

export class AgentMigrationTransferError extends Error {
  constructor(
    readonly code: AgentMigrationTransferErrorCode,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "AgentMigrationTransferError";
  }
}
