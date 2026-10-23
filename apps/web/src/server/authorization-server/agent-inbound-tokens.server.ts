import { ID_PATTERN } from "./installation-tokens.server";
import {
  AGENT_INBOUND_TOKEN_TTL_SECONDS,
  mintAgentInboundAccessToken,
  verifyAgentInboundAccessToken,
  type TokenIssuer,
} from "./issued-tokens.server";
import {
  inboundRequestExpired,
  coversScopes,
  inboundScopesOf,
} from "#src/server/app-agent-events/inbound-rules.server";
import type { StoredInboundRequest } from "#src/server/app-agent-events/app-agent-inbound.server";

/** The grant type with which an app exchanges an approved Agent request for a token. */
export const AGENT_REQUEST_GRANT_TYPE = "urn:coforge:params:oauth:grant-type:agent_request";

const AGENT_INBOUND_RESOURCE_PATH = "/api/workspaces/";
const AGENT_INBOUND_RESOURCE_SUFFIX = "/agent-inbound";

/** The resource URI of a Workspace's agent-inbound API under the issuer's origin: the audience of
 * every Agent inbound token (RFC 8707 resource indicator). */
export function agentInboundResource(issuer: string, workspaceId: string): string {
  return `${new URL(issuer).origin}${AGENT_INBOUND_RESOURCE_PATH}${workspaceId}${AGENT_INBOUND_RESOURCE_SUFFIX}`;
}

/** RFC 6749 §5.2 and RFC 8707 §2 refusals of an `agent_request` exchange; `authorization_pending`
 * and `access_denied` are RFC 8628 §3.5's, for a request that waits or was denied. */
export type AgentInboundRefusal =
  | "invalid_request"
  | "invalid_grant"
  | "invalid_target"
  | "invalid_scope"
  | "unauthorized_client"
  | "authorization_pending"
  | "access_denied";

export type IssuedAgentInboundToken =
  | {
      status: "issued";
      body: {
        access_token: string;
        token_type: "Bearer";
        expires_in: number;
        scope: string;
        resource: string;
      };
    }
  | { status: "refused"; error: AgentInboundRefusal; description: string };

/** The facts a token is checked against each time it is exchanged or used. */
export interface AgentInboundTokenStore {
  findRequest(requestId: string): Promise<StoredInboundRequest | undefined>;
  markExchanged(requestId: string, appId: string): Promise<boolean>;
  findTokenFacts(input: { appKey: string; workspaceId: string; agentId: string }): Promise<
    | {
        app: { id: string; key: string; name: string };
        workspaceSlug: string;
        /** The grant works for the Agent (`effectiveInboundAccess`), and what it holds. */
        working: boolean;
        scopes: string[];
      }
    | undefined
  >;
}

/** Whether `app-agent-events` is on for the Workspace. */
export type AgentEventsFlag = (workspace: {
  workspaceId: string;
  workspaceSlug: string;
}) => Promise<boolean>;

export type VerifiedAgentInboundToken =
  | {
      status: "verified";
      appId: string;
      appKey: string;
      appName: string;
      workspaceId: string;
      agentId: string;
      scopes: string[];
    }
  /** RFC 6750 §3.1: an unusable token is 401 `invalid_token`, a token for less than is asked 403. */
  | { status: "refused"; error: "invalid_token" | "insufficient_scope" };

const refuse = (error: AgentInboundRefusal, description: string) =>
  ({ status: "refused", error, description }) as const;

/**
 * Agent inbound tokens (RFC 6749 §4.5 extension grant, RFC 8707 resource, RFC 9068 JWT): an app
 * exchanges its approved, one-time request for a token bound to one Agent, the request's Workspace
 * and that Workspace's agent-inbound resource. A token holds only while the facts hold: `verify`
 * reads the installation, the Agent and the grant again, so an uninstall, a deleted Agent or a
 * person's revocation ends it at once. Behind `app-agent-events`.
 */
export class AgentInboundTokens {
  constructor(
    private readonly store: AgentInboundTokenStore,
    private readonly flagEnabled: AgentEventsFlag,
    private readonly options: TokenIssuer,
  ) {}

  /** The token for the authenticated app `client` exchanging `form`'s `request_id` and `resource`. */
  async exchange(
    client: { id: string; key: string },
    form: URLSearchParams,
    now: Date,
  ): Promise<IssuedAgentInboundToken> {
    const result = await this.decide(client, form, now);
    console.info(
      JSON.stringify({
        event:
          result.status === "issued"
            ? "authorization_server:agent_inbound_token_issued"
            : "authorization_server:agent_inbound_token_refused",
        app_key: client.key,
        outcome: result.status === "issued" ? "issued" : result.error,
      }),
    );
    return result;
  }

  private async decide(
    client: { id: string; key: string },
    form: URLSearchParams,
    now: Date,
  ): Promise<IssuedAgentInboundToken> {
    const requestId = form.get("request_id");
    if (!requestId) return refuse("invalid_request", "request_id is required");
    const resource = form.get("resource");
    if (!resource) return refuse("invalid_target", "resource is required for Agent inbound scopes");
    const request = ID_PATTERN.test(requestId)
      ? await this.store.findRequest(requestId)
      : undefined;
    // Another app's request is answered like one that does not exist.
    if (!request || request.appId !== client.id)
      return refuse("invalid_grant", "the request is not valid");
    if (resource !== agentInboundResource(this.options.issuer, request.workspace.id))
      return refuse("invalid_target", "resource does not match the requested Workspace");
    if (
      !(await this.flagEnabled({
        workspaceId: request.workspace.id,
        workspaceSlug: request.workspace.slug,
      }))
    )
      return refuse("unauthorized_client", "the client may not use this grant type here");
    if (
      request.status !== "denied" &&
      !request.exchangedAt &&
      inboundRequestExpired(request.createdAt, now)
    )
      return refuse("invalid_grant", "the request has expired");
    if (request.status === "pending")
      return refuse("authorization_pending", "the request waits for a person to approve it");
    if (request.status === "denied") return refuse("access_denied", "the request was denied");
    if (request.exchangedAt) return refuse("invalid_grant", "request_already_consumed");
    const scopes = inboundScopesOf(request.scopes);
    const facts = await this.store.findTokenFacts({
      appKey: client.key,
      workspaceId: request.workspace.id,
      agentId: request.agent.id,
    });
    if (!facts) return refuse("invalid_grant", "the request is no longer valid");
    if (!facts.working) return refuse("invalid_grant", "the request is no longer valid");
    if (!coversScopes(facts.scopes, scopes))
      return refuse("invalid_scope", "the app no longer declares or holds these scopes");
    // Another exchange may have won since the request was read.
    if (!(await this.store.markExchanged(request.id, client.id)))
      return refuse("invalid_grant", "request_already_consumed");
    const scope = scopes.join(" ");
    const accessToken = await mintAgentInboundAccessToken(
      this.options,
      {
        appKey: client.key,
        agentId: request.agent.id,
        workspaceId: request.workspace.id,
        requestId: request.id,
        scope,
      },
      resource,
      now,
    );
    return {
      status: "issued",
      body: {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: AGENT_INBOUND_TOKEN_TTL_SECONDS,
        scope,
        resource,
      },
    };
  }

  /**
   * Whether `token` lets its app send to its Agent now: the signature, `iss`, `typ`, `aud` (the
   * Workspace's agent-inbound resource), `exp` and claims, then the app, installation, Agent and
   * grant. A grant that is gone or revoked, or a flag that is off, is `invalid_token`; a token
   * whose scopes the app no longer declares or holds is `insufficient_scope`.
   */
  async verify(token: string, now: Date): Promise<VerifiedAgentInboundToken> {
    const claims = await verifyAgentInboundAccessToken(
      this.options,
      token,
      (workspaceId) => agentInboundResource(this.options.issuer, workspaceId),
      now,
    );
    if (!claims || claims.subject !== claims.appKey || !ID_PATTERN.test(claims.workspaceId))
      return { status: "refused", error: "invalid_token" };
    const scopes = inboundScopesOf(claims.scope.split(" "));
    if (scopes.length === 0) return { status: "refused", error: "invalid_token" };
    const facts = await this.store.findTokenFacts(claims);
    if (
      !facts ||
      !facts.working ||
      !(await this.flagEnabled({
        workspaceId: claims.workspaceId,
        workspaceSlug: facts.workspaceSlug,
      }))
    )
      return { status: "refused", error: "invalid_token" };
    if (!coversScopes(facts.scopes, scopes))
      return { status: "refused", error: "insufficient_scope" };
    return {
      status: "verified",
      appId: facts.app.id,
      appKey: facts.app.key,
      appName: facts.app.name,
      workspaceId: claims.workspaceId,
      agentId: claims.agentId,
      scopes,
    };
  }
}
