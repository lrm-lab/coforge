import {
  AGENT_EVENT_BODY_MAX_BYTES,
  parseAgentEventInput,
} from "#src/features/apps/app-agent-events";
import { isAgentInboundScope } from "#src/features/apps/app-agent-events";
import type { AgentEvents } from "#src/server/app-agent-events/agent-events.server";
import type { AppAgentInbound } from "#src/server/app-agent-events/app-agent-inbound.server";
import { InboundScopeNotAllowedError } from "#src/server/app-agent-events/inbound-rules.server";
import type { AppRateLimit } from "#src/server/app-rate-limits/app-rate-limit.server";
import { bearerChallenge, bearerFromRequest } from "./bearer-challenge.server";
import { authenticateClient } from "./client-authentication.server";
import { agentInboundResource, type AgentInboundTokens } from "./agent-inbound-tokens.server";
import type { GrantStore } from "./grants.server";
import { NO_STORE, refuseIfRateLimited } from "./http-headers.server";
import { ID_PATTERN } from "./installation-tokens.server";
import { insufficientScope } from "./installation-bearer.server";

const failure = (status: 400 | 403 | 404 | 413, error: string, description: string) =>
  Response.json({ error, error_description: description }, { status, headers: NO_STORE });

/** The request's JSON body, or `undefined` for anything that is not JSON. */
function jsonBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The HTTP side of Agent inbound, behind `app-agent-events`: an app asks to send to one Agent with
 * its client credentials (`request`, `status`), exchanges the approved request at the token
 * endpoint (`AgentInboundTokens.exchange`), and posts events with the token it got (`events`).
 * Bodies and refusals are snake_case like the other endpoints an app calls.
 */
export class AgentInboundEndpoint {
  private readonly now: () => Date;

  constructor(
    private readonly inbound: AppAgentInbound,
    private readonly events: AgentEvents,
    private readonly tokens: AgentInboundTokens,
    private readonly store: Pick<GrantStore, "findClient">,
    private readonly limits: { requests: AppRateLimit; events: AppRateLimit },
    private readonly options: { issuer: string; now?: () => Date },
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /** `POST {workspace_slug, agent_id | agent_name, scopes}` with the app's client credentials. */
  async request(request: Request): Promise<Response> {
    const authenticated = await authenticateClient(request, this.store, this.options.issuer);
    if (authenticated instanceof Response) return authenticated;
    const limited = await refuseIfRateLimited(this.limits.requests, authenticated.client.id);
    if (limited) return limited;
    const body = jsonBody(await request.text());
    const { workspace_slug, agent_id, agent_name, scopes } = (
      typeof body === "object" && body !== null ? body : {}
    ) as Record<string, unknown>;
    if (typeof workspace_slug !== "string" || !workspace_slug)
      return failure(400, "invalid_request", "workspace_slug is required");
    if (agent_id !== undefined && (typeof agent_id !== "string" || !ID_PATTERN.test(agent_id)))
      return failure(400, "invalid_request", "agent_id must be an Agent id");
    if (agent_name !== undefined && typeof agent_name !== "string")
      return failure(400, "invalid_request", "agent_name must be a string");
    if (agent_id === undefined && !agent_name)
      return failure(400, "invalid_request", "agent_id or agent_name is required");
    if (
      !Array.isArray(scopes) ||
      scopes.length === 0 ||
      scopes.length > 8 ||
      scopes.some((scope) => typeof scope !== "string")
    )
      return failure(400, "invalid_request", "scopes must name the Agent inbound scopes");
    try {
      const view = await this.inbound.request(
        authenticated.client.id,
        {
          workspaceSlug: workspace_slug,
          ...(agent_id ? { agentId: agent_id as string } : { agentName: agent_name as string }),
        },
        scopes as string[],
      );
      return view
        ? Response.json(this.requestBody(view), { headers: NO_STORE })
        : failure(404, "not_found", "no such Agent for this app");
    } catch (error) {
      if (error instanceof InboundScopeNotAllowedError)
        return failure(400, "invalid_scope", "the app does not declare these Agent inbound scopes");
      throw error;
    }
  }

  /** `GET` the app's own request, to see whether a person approved it. */
  async status(request: Request, requestId: string): Promise<Response> {
    const authenticated = await authenticateClient(request, this.store, this.options.issuer);
    if (authenticated instanceof Response) return authenticated;
    const view = ID_PATTERN.test(requestId)
      ? await this.inbound.status(authenticated.client.id, requestId)
      : undefined;
    return view
      ? Response.json(this.requestBody(view), { headers: NO_STORE })
      : failure(404, "not_found", "no such request for this app");
  }

  /** `POST {kind, summary, payload?, external_event_id?, ttl_seconds?, agent_id?}` with the token. */
  async post(request: Request): Promise<Response> {
    const issuer = this.options.issuer;
    const token = bearerFromRequest(request, issuer);
    if (token instanceof Response) return token;
    const verified = await this.tokens.verify(token, this.now());
    if (verified.status === "refused")
      return verified.error === "insufficient_scope"
        ? insufficientScope(issuer)
        : bearerChallenge(issuer, 401, {
            error: "invalid_token",
            description: "the access token is not valid",
          });
    const limited = await refuseIfRateLimited(
      this.limits.events,
      `${verified.appId}:${verified.agentId}`,
    );
    if (limited) return limited;
    const declared = Number(request.headers.get("content-length") ?? 0);
    const text = declared > AGENT_EVENT_BODY_MAX_BYTES ? undefined : await request.text();
    if (text === undefined || new TextEncoder().encode(text).length > AGENT_EVENT_BODY_MAX_BYTES)
      return failure(413, "payload_too_large", "the event is larger than the limit");
    const input = parseAgentEventInput(jsonBody(text));
    if (!input.ok) return failure(400, "invalid_request", input.description);
    const result = await this.events.accept(
      {
        appId: verified.appId,
        appKey: verified.appKey,
        appName: verified.appName,
        workspaceId: verified.workspaceId,
        agentId: verified.agentId,
        scopes: verified.scopes.filter(isAgentInboundScope),
      },
      input.value,
    );
    switch (result.status) {
      case "insufficient_scope":
        return insufficientScope(issuer, result.scope);
      case "too_large":
        return failure(413, "payload_too_large", "the event is longer than a message may be");
      case "other_agent":
        return failure(403, "access_denied", "token cannot target a different agent");
      case "deduped":
        return Response.json(
          { event_id: result.eventId, status: "queued", deduped: true },
          { status: 200, headers: NO_STORE },
        );
      case "queued":
        return Response.json(
          { event_id: result.eventId, status: "queued", deduped: false },
          { status: 202, headers: NO_STORE },
        );
    }
  }

  private requestBody(view: NonNullable<Awaited<ReturnType<AppAgentInbound["status"]>>>) {
    return {
      request_id: view.id,
      status: view.status,
      scopes: view.scopes,
      agent: {
        id: view.agent.id,
        name: view.agent.name,
        display_name: view.agent.displayName,
        workspace_id: view.agent.workspaceId,
        workspace_slug: view.agent.workspaceSlug,
      },
      resource: agentInboundResource(this.options.issuer, view.agent.workspaceId),
    };
  }
}
