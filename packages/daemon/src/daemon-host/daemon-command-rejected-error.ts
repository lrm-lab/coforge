export class DaemonCommandRejectedError extends Error {
  constructor(
    readonly operation: string,
    message: string,
    readonly code?: string,
    readonly workspaceId?: string,
  ) {
    super(message);
    this.name = "DaemonCommandRejectedError";
  }
}
