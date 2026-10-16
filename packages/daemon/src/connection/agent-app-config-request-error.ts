import type { AgentAppConfigErrorCode } from "@lrm/coforge-sdk/agent";

/**
 * A well-formed `{ ok: false, errorCode, error }` response from `GET`/`PATCH
 * /api/agent/v1/apps/:appId/config` (same envelope convention as the profile routes). Carried
 * through verbatim to the CLI instead of being folded into the generic proxy-failure taxonomy.
 */
export class AgentAppConfigRequestError extends Error {
  readonly errorCode: AgentAppConfigErrorCode;
  readonly status: number;

  constructor(errorCode: AgentAppConfigErrorCode, message: string, status: number) {
    super(message);
    this.name = "AgentAppConfigRequestError";
    this.errorCode = errorCode;
    this.status = status;
  }
}
