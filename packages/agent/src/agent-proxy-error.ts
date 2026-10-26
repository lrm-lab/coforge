import {
  decodeMemoryOfferPublication,
  isOpenVikingAgentError,
  type MemoryOfferPublication,
} from "@lrm/coforge-sdk/agent";

/** Preserve HTTP and server error fields through the native tool boundary. */
export class AgentProxyError extends Error {
  readonly code?: string;
  readonly operationId?: string;
  readonly publication?: MemoryOfferPublication;

  constructor(
    readonly status: number,
    readonly payload: unknown,
  ) {
    super(proxyFailureText(payload, status));
    this.name = "AgentProxyError";
    if (isOpenVikingAgentError(payload)) {
      this.code = payload.error.code;
      this.operationId = payload.operationId;
      this.publication = decodeMemoryOfferPublication(payload.publication);
    }
  }
}

function proxyFailureText(payload: unknown, status: number): string {
  if (!payload || typeof payload !== "object" || !("error" in payload))
    return `CoForge Agent proxy request failed (${status})`;
  const error = payload.error;
  if (typeof error === "string" && error.length > 0) return error;
  if (error && typeof error === "object") {
    const record = error as { code?: unknown; message?: unknown };
    const message = typeof record.message === "string" ? record.message : "";
    const code = typeof record.code === "string" ? record.code : "";
    if (message && code) return `${message} (${code})`;
    if (message) return message;
    if (code) return code;
  }
  return `CoForge Agent proxy request failed (${status})`;
}
