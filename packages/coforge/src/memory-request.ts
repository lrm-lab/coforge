import {
  LOCAL_MEMORY_ROUTE,
  decodeLocalMemoryResult,
  type LocalMemoryCommand,
  type LocalMemoryResult,
} from "@lrm/coforge-sdk/agent";
import { envelopeRequest } from "./proxy-request";

export function memoryRequests(endpoint: (path: string) => URL, context: string, proxyUrl: string) {
  return {
    memory: (body: LocalMemoryCommand): Promise<LocalMemoryResult> =>
      envelopeRequest(
        endpoint,
        context,
        proxyUrl,
        { ...LOCAL_MEMORY_ROUTE, body },
        decodeLocalMemoryResult,
        (value) => {
          if (
            typeof value !== "object" ||
            value === null ||
            !("errorCode" in value) ||
            !("error" in value) ||
            typeof value.errorCode !== "string" ||
            typeof value.error !== "string"
          )
            return undefined;
          return { errorCode: value.errorCode, error: value.error };
        },
        "memory",
        (code) =>
          code === "memory_conflict"
            ? "Read the current memory and compare before updating it."
            : undefined,
      ),
  };
}
