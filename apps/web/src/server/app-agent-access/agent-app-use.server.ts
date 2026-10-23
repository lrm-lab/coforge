import type { AgentAppView } from "@lrm/coforge-sdk/agent";
import { BUILT_IN_APPS } from "@lrm/coforge-sdk/internal";
import { AppError, isAppError, type AppErrorCode } from "#src/lib/app-error";
import type { AuthorizationServerConfiguration } from "#src/server/authorization-server/configuration.server";
import {
  AGENT_TOKEN_TTL_SECONDS,
  mintAgentAccessToken,
} from "#src/server/authorization-server/issued-tokens.server";
import { withFixedScopes } from "#src/features/apps/agent-app-access";
import type { AppGrantCards } from "#src/server/conversations/app-grant-cards.server";
import type { AppAgentAccess } from "./app-agent-access.server";

/** How many times a use is decided again after a person decided its waiting request while its
 * approval card was being posted. */
const DECIDE_ATTEMPTS = 2;

/** The Agent asking, as its Agent API key names it. */
export type AppUsingAgent = { workspaceId: string; agentId: string };

export type AgentAppTokenOutcome =
  | { status: "issued"; accessToken: string; expiresIn: number; audience: string; scope: string }
  | {
      status: "approval_required";
      requestId: string;
      actionCardMessageId?: string;
      /** What the waiting request asks a person to grant. */
      scopes: string[];
    }
  | { status: "not_installed" }
  /** This server runs no authorization server, so it issues no tokens. */
  | { status: "unavailable" }
  /** The approval card could not be posted to the target: `code` is why. */
  | { status: "target_refused"; code: AppErrorCode; requestId: string };

export type AgentAppUsePorts = {
  access: Pick<AppAgentAccess, "listForAgent" | "resolveAgentAccess">;
  cards: Pick<AppGrantCards, "find" | "post">;
  issuer: () => AuthorizationServerConfiguration;
  workspaceSlug: (workspaceId: string) => Promise<string>;
  now?: () => Date;
};

/**
 * An Agent using the apps of its Workspace (`coforge app list|token`): what it may use, and a
 * five-minute token for one. Using an app follows `AppAgentAccess.resolveAgentAccess`; when a
 * person must approve it, the approval card is posted to the target the Agent names, once per
 * waiting request, and never for a request a person has already decided.
 */
export class AgentAppUse {
  constructor(private readonly ports: AgentAppUsePorts) {}

  /** The installed apps with the Agent's access to each, then the built-in Agent Apps. */
  async list(agent: AppUsingAgent): Promise<AgentAppView[]> {
    const installed = await this.ports.access.listForAgent(agent);
    return [
      ...installed.map((app) => ({ ...app, builtIn: false })),
      ...BUILT_IN_APPS.map(({ key, name, description, whenToUse }) => ({
        key,
        name,
        description,
        whenToUse,
        homepageUrl: null,
        builtIn: true,
      })),
    ];
  }

  async token(
    agent: AppUsingAgent,
    appKey: string,
    { target, scopes }: { target?: string; scopes?: string[] } = {},
  ): Promise<AgentAppTokenOutcome> {
    const issuer = this.ports.issuer();
    if (issuer.status !== "ready") return { status: "unavailable" };
    const workspaceSlug = this.ports.workspaceSlug(agent.workspaceId);
    // Settled at once, so a use that issues no token leaves no unhandled rejection behind.
    workspaceSlug.catch(() => {});
    for (let attempt = 0; attempt < DECIDE_ATTEMPTS; attempt++) {
      const outcome = await this.ports.access.resolveAgentAccess(agent, appKey, scopes);
      if (outcome.status === "not_installed") return outcome;
      if (outcome.status === "granted") {
        // Asked for scopes: exactly those and the fixed ones, not everything the grant holds.
        const issuedScopes = scopes ? withFixedScopes(scopes) : outcome.scopes;
        const accessToken = await mintAgentAccessToken(
          issuer,
          {
            agentId: agent.agentId,
            appKey,
            workspaceId: agent.workspaceId,
            workspaceSlug: await workspaceSlug,
            scopes: issuedScopes,
          },
          this.ports.now?.() ?? new Date(),
        );
        return {
          status: "issued",
          accessToken,
          expiresIn: AGENT_TOKEN_TTL_SECONDS,
          audience: appKey,
          scope: issuedScopes.join(" "),
        };
      }
      const { requestId } = outcome;
      let actionCardMessageId = await this.ports.cards.find(agent.workspaceId, requestId);
      if (!actionCardMessageId && target) {
        try {
          actionCardMessageId = await this.ports.cards.post(agent, target, {
            id: requestId,
            appKey,
            appName: outcome.appName,
            scopes: outcome.scopes,
          });
        } catch (error) {
          if (!isAppError(error)) throw error;
          return { status: "target_refused", code: error.code, requestId };
        }
        // A person decided the request meanwhile: what the use gets now is decided again.
        if (!actionCardMessageId) continue;
      }
      return {
        status: "approval_required",
        requestId,
        scopes: outcome.scopes,
        ...(actionCardMessageId ? { actionCardMessageId } : {}),
      };
    }
    throw new AppError("CONFLICT");
  }
}
