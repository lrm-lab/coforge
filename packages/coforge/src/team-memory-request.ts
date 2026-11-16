import {
  TEAM_MEMORY_ROUTE,
  decodeTeamMemoryResult,
  type TeamMemoryCommand,
} from "@lrm/coforge-sdk/agent";
import { envelopeRequest } from "./proxy-request";
export function teamMemoryRequests(
  endpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
) {
  return {
    teamMemory: (body: TeamMemoryCommand) =>
      envelopeRequest(
        endpoint,
        context,
        proxyUrl,
        { ...TEAM_MEMORY_ROUTE, body },
        decodeTeamMemoryResult,
        (value) =>
          typeof value === "object" &&
          value !== null &&
          "errorCode" in value &&
          "error" in value &&
          typeof value.errorCode === "string" &&
          typeof value.error === "string"
            ? { errorCode: value.errorCode, error: value.error }
            : undefined,
        "team_memory",
        (code) =>
          code === "memory_conflict"
            ? "Read current entries and prepare again before retrying with current revisions."
            : undefined,
      ),
  };
}
