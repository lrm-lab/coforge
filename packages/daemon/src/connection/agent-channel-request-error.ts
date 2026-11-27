import type { AgentChannelErrorCode } from "@lrm/coforge-sdk/agent";

export class AgentChannelRequestError extends Error {
  readonly errorCode: AgentChannelErrorCode;
  readonly status: number;

  constructor(errorCode: AgentChannelErrorCode, message: string, status: number) {
    super(message);
    this.name = "AgentChannelRequestError";
    this.errorCode = errorCode;
    this.status = status;
  }
}
