import { textResponse } from "#src/server/http/text-response.server";
import { AgentChannelManagementError } from "#src/server/conversations/agent-channel-management-error.server";
import type { AgentChannelManagementRepository } from "#src/server/conversations/agent-channel-management.server";
import { agentIdempotencyKey, readAgentJsonBody } from "./agent-http-routes.server";

/** Who a channel-management route acts as: one Agent, in one Workspace. Declared once here because
 * the whole family shares it - the route files under `routes/api/agent/v1/channels*` each used to
 * spell it out, and export it, themselves (nothing imported those copies). */
export type AgentChannelManagementPrincipal = { workspaceId: string; agentId: string };

// Every route in this family treats `idempotencyKey` as optional, as the mute/unmute routes it was
// modeled on do, so a POST body may be empty or absent (`readJsonBody` tolerates both).
export {
  agentIdempotencyKey as idempotencyKeyFrom,
  agentIdempotencyKeyFromQuery as idempotencyKeyFromQuery,
  readAgentJsonBody as readJsonBody,
} from "./agent-http-routes.server";

/** Apply the archive state selected by the route, preserving the shared response envelope. */
export async function handleAgentChannelArchiveStatePost(
  request: Request,
  channel: string,
  principal: AgentChannelManagementPrincipal,
  repository: AgentChannelManagementRepository,
  archived: boolean,
): Promise<Response> {
  const body = await readAgentJsonBody(request);
  const idempotencyKey = agentIdempotencyKey(body);
  try {
    const result = await repository.setArchived(
      principal.workspaceId,
      principal.agentId,
      channel,
      archived,
    );
    return Response.json({ idempotencyKey, ...result });
  } catch (error) {
    return channelManagementErrorResponse(
      error,
      `channel ${archived ? "archive" : "unarchive"} failed`,
    );
  }
}

/**
 * Maps a channel-management failure onto its declared HTTP status and body; anything else (an
 * unexpected repository failure) is hidden behind a generic message, matching the mute/unmute
 * routes' `catch` behavior. An `errorCode`-carrying failure (`agent_not_visible`)
 * serializes as the `{ ok: false, errorCode, error }` JSON envelope so the Agent CLI can read a
 * real wire field instead of the message text; every other failure stays plain text.
 */
export function channelManagementErrorResponse(error: unknown, fallbackMessage: string): Response {
  if (error instanceof AgentChannelManagementError) {
    if (error.errorCode)
      return Response.json(
        { ok: false, errorCode: error.errorCode, error: error.message },
        { status: error.status },
      );
    return textResponse(error.message, { status: error.status });
  }
  return textResponse(fallbackMessage, { status: 400 });
}
