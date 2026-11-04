import type { AgentTaskConversationRequest } from "@lrm/coforge-sdk/agent";
import type { AgentMessageRecord } from "@lrm/coforge-sdk/internal";
import type { AgentContexts } from "./agent-contexts";
import { elideForAgent } from "./context-elision";

/**
 * A forwarded `coforge task read`'s answer as the Agent gets it: the read's consumption settles
 * into the daemon's cursor (`recordRead`), and sender introductions the Agent has already seen
 * are elided. Any other route, a refusal, or a body that is not a message list passes as it came.
 */
export async function forwardedTaskReadResponse(
  input: {
    agentId: string;
    request: AgentTaskConversationRequest;
    contexts?: Pick<AgentContexts, "ledger">;
    recordRead?: (
      agentId: string,
      query: Record<string, string> | undefined,
      body: unknown,
    ) => void;
  },
  response: Response,
): Promise<Response> {
  const { agentId, request } = input;
  if (request.route !== "read" || !response.ok) return response;
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return response;
  }
  if (
    !body ||
    typeof body !== "object" ||
    !Array.isArray((body as { messages?: unknown }).messages)
  )
    return response;
  const scope = (body as { consumptionScope?: { agentId: string; target: string } })
    .consumptionScope;
  if (scope?.agentId === agentId && scope.target) input.recordRead?.(agentId, request.query, body);
  const messages = (body as { messages: unknown[] }).messages;
  const elided = elideForAgent(input.contexts, agentId, messages as AgentMessageRecord[], "read");
  if (elided === messages) return response;
  const next = { ...(body as Record<string, unknown>), messages: elided };
  // The upstream response is fetch's already-decoded body: `content-encoding` still names the
  // wire compression and `content-length` the old byte count, neither of which describes the
  // rewritten JSON. Only the media type survives.
  const headers = new Headers();
  const contentType = response.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const rewritten = new Response(JSON.stringify(next), {
    status: response.status,
    statusText: response.statusText,
    headers,
  }) as Response & { messages?: unknown };
  // `guardDelivery` reads this non-serialized field to release claims if the local client
  // disconnects before consuming the rewritten response body.
  rewritten.messages = elided;
  return rewritten;
}
