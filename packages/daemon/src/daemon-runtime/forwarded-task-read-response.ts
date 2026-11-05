import { getLogger } from "@logtape/logtape";
import type { AgentTaskConversationRequest } from "@lrm/coforge-sdk/agent";
import type { AgentMessageRecord } from "@lrm/coforge-sdk/internal";
import type { AgentContexts } from "./agent-contexts";
import { elideForAgent } from "./context-elision";

const logger = getLogger(["coforge", "daemon", "runtime"]);

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
  if (request.route !== "read") return response;
  // Why a task read's cursor was not recorded, field by field: the failure is otherwise invisible,
  // and a cursor the daemon never wrote turns every replayed delivery into a new notice.
  const notRecorded = (reason: string, detail: Record<string, unknown> = {}) =>
    logger.info("Forwarded task read did not record its consumption", {
      event: "agent.task_read.not_recorded",
      agent_id: agentId,
      reason,
      ...detail,
    });
  if (!response.ok) {
    notRecorded("response_not_ok", { status: response.status });
    return response;
  }
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    notRecorded("body_not_json");
    return response;
  }
  if (
    !body ||
    typeof body !== "object" ||
    !Array.isArray((body as { messages?: unknown }).messages)
  ) {
    notRecorded("body_without_messages");
    return response;
  }
  const scope = (body as { consumptionScope?: { agentId: string; target: string } })
    .consumptionScope;
  if (scope?.agentId === agentId && scope.target) {
    input.recordRead?.(agentId, request.query, body);
    // The recorded boundary is the one value that says whether a read moved the cursor: the
    // server's `modelSeenUpToSeq` (and its own read position) as this Agent received them.
    const page = body as {
      messages: unknown[];
      modelSeenUpToSeq?: unknown;
      readPositionAfter?: unknown;
    };
    logger.info("Forwarded task read recorded its consumption", {
      event: "agent.task_read.recorded",
      agent_id: agentId,
      target: scope.target,
      model_seen_up_to_seq: page.modelSeenUpToSeq ?? null,
      read_position_after: page.readPositionAfter ?? null,
      messages: page.messages.length,
      unread: request.query?.unread === "true",
    });
  } else
    notRecorded("scope_missing_or_foreign", {
      has_consumption_scope: scope !== undefined,
      scope_agent_matches: scope?.agentId === agentId,
      scope_target_present: Boolean(scope?.target),
    });
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
