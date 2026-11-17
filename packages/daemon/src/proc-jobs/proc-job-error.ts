import type { AgentProcErrorCode, AgentProcJob } from "@lrm/coforge-sdk/agent";

export type ProcJobErrorStatus = 400 | 403 | 404 | 409 | 500 | 501;

export class ProcJobError extends Error {
  constructor(
    readonly errorCode: AgentProcErrorCode,
    readonly status: ProcJobErrorStatus,
    message: string,
    readonly jobs?: AgentProcJob[],
  ) {
    super(message);
    this.name = "ProcJobError";
  }
}
