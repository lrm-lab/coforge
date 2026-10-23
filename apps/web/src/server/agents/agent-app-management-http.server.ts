import {
  APP_REGISTRATION_REQUEST_MAX_BYTES,
  decodeAgentAppRegistrationRequest,
  type AgentAppManagementRequest,
} from "@lrm/coforge-sdk/agent";
import { readCappedJson } from "#src/server/http/capped-json-body.server";
import { agentAppOwnerRefusal, agentAppRefusal } from "./agent-app-refusals.server";

type Operation = AgentAppManagementRequest["operation"];

/** Where a request's JSON body goes in the decoded request: its `changes` (`app update`), its own
 * fields, or nowhere (the operation takes none). */
type BodyAs = "changes" | "fields" | "none";

/**
 * One Agent app-management route: decodes the request with the SDK's own decoder (the operation
 * name is the one the CLI and the daemon use), runs it, and answers `{ ok: true, ...result }` with
 * `cache-control: no-store` (a share link's URL is in one answer). A request the decoder refuses is
 * `request_invalid`; a service refusal is `agentAppOwnerRefusal`'s.
 */
export async function handleAgentAppManagement<Op extends Operation>(
  request: Request,
  route: { operation: Op; clientKey: string; bodyAs: BodyAs },
  run: (decoded: Extract<AgentAppManagementRequest, { operation: Op }>) => Promise<object>,
): Promise<Response> {
  let body: unknown = {};
  if (route.bodyAs !== "none") {
    const read = await readCappedJson(request, APP_REGISTRATION_REQUEST_MAX_BYTES);
    if (!read.ok)
      return agentAppRefusal(
        "request_invalid",
        read.reason === "too_large"
          ? "The request body is too large."
          : "The request body is not JSON.",
      );
    body = read.value;
  }
  const { operation, clientKey, bodyAs } = route;
  const decoded = decodeAgentAppRegistrationRequest({
    operation,
    clientKey,
    ...(bodyAs === "changes" ? { changes: body } : bodyAs === "fields" ? (body as object) : {}),
  });
  if (!decoded || decoded.operation !== operation)
    return agentAppRefusal(
      "request_invalid",
      "The request does not match what the operation takes.",
    );
  try {
    const result = await run(decoded as Extract<AgentAppManagementRequest, { operation: Op }>);
    return Response.json({ ok: true, ...result }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return agentAppOwnerRefusal(error);
  }
}
