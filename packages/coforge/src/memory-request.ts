import {
  agentApiRoutes,
  type PlatformMemoryCommand,
  type PlatformMemoryResult,
} from "@lrm/coforge-sdk/agent";
import { envelopeRequest } from "./proxy-request";

export function memoryRequest(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
  request: PlatformMemoryCommand,
): Promise<PlatformMemoryResult> {
  return envelopeRequest(
    proxyEndpoint,
    context,
    proxyUrl,
    { ...agentApiRoutes.local.memory, body: request },
    (value) => {
      if (
        !value ||
        typeof value !== "object" ||
        !("entries" in value) ||
        !Array.isArray(value.entries) ||
        !("enabled" in value) ||
        typeof value.enabled !== "boolean"
      )
        throw new Error("Invalid memory response");
      return value as PlatformMemoryResult;
    },
    (value) => {
      if (!value || typeof value !== "object") return undefined;
      const row = value as Record<string, unknown>;
      return {
        errorCode: String(row.errorCode ?? row.code ?? "MEMORY_FAILED"),
        error: typeof row.error === "string" ? row.error : "Memory request failed",
      };
    },
    "memory",
  );
}
