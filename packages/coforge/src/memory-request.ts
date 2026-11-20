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
            ? body.operation === "save"
              ? `Run coforge memory get --key ${body.key}, read the full entry and compare sources. Update it with coforge memory save --key ${body.key} --revision '<returned revision>' and the full --title, --content and --source fields; preserve its kind and applicability. Do not delete the file or retry with a guessed revision.`
              : "Read the current memory and compare before updating it."
            : undefined,
      ),
  };
}
