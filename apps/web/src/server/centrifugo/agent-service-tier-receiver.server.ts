import { decodeAgentServiceTier, type AgentServiceTier } from "@lrm/coforge-sdk/internal";
import type { AgentControlStore } from "#src/server/agents/agent-control.server";
import type { AgentDisplay } from "#src/server/agents/agent-display.server";
import type { CentrifugoServerApi } from "./server-api.server";
import {
  agentStatusChannel,
  agentStatusChannelForAgent,
} from "#src/features/agents/agent-status-channel";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import type { CentrifugoRpcMethod } from "./rpc-handler.server";
import { rejectNonDaemonPrincipal } from "./daemon-principal.server";
import { errorType } from "#src/server/errors/error-type.server";

/**
 * Fire-and-forget from the daemon's side (never awaited or retried there), gated exactly like
 * `agent:context:usage` (`agent-context-usage-receiver.server.ts`): accepted only when
 * `AgentControlState.launchId === message.launchId` for the Agent, so a dead or superseded
 * launch's reading never paints the badge. Every domain-level mismatch (unknown Agent, foreign
 * scope, non-matching provider, stale launch) is its own idempotent no-op — the daemon must never
 * treat this observation as something to retry. A malformed payload or foreign transport
 * principal is the only 403.
 *
 * The reading is stored on the same display projection as the context-window one, so the browser
 * learns what tier the launch actually got from the `agent:display` push it already listens to.
 */
export function createAgentServiceTierMethod(
  agents: Pick<AgentControlStore, "get">,
  display: Pick<AgentDisplay, "putServiceTier"> | undefined = undefined,
  displayEvents: Pick<CentrifugoServerApi, "publishJson"> | undefined = undefined,
  /** The Agent's current visibility, read fresh (no cache) — a lookup that finds nothing to route
   * by skips the display push entirely (fails closed), never defaulting to the shared channel. */
  agentVisibility: (workspaceId: string, agentId: string) => Promise<string | undefined>,
): CentrifugoRpcMethod {
  return async (payload, metadata) => {
    const rejection = rejectNonDaemonPrincipal(metadata.principal);
    if (rejection) return rejection;
    let message: AgentServiceTier | undefined;
    try {
      message = decodeAgentServiceTier(payload);
    } catch {
      return { code: 400, message: "invalid Agent service tier" };
    }
    if (
      metadata.principal.workspaceId !== message.workspaceId ||
      metadata.principal.computerId !== message.computerId
    )
      return { code: 403, message: "Agent service tier scope is not authorized" };
    try {
      const agent = await agents.get(message.agentId);
      if (
        !agent ||
        agent.workspaceId !== message.workspaceId ||
        agent.computerId !== message.computerId ||
        agent.runtimeConfig.runtime !== message.provider ||
        agent.state?.launchId !== message.launchId
      )
        return new Uint8Array();
      if (display) {
        const snapshot = await display.putServiceTier(message);
        if (snapshot && displayEvents) {
          const visibility = await agentVisibility(message.workspaceId, message.agentId);
          if (visibility !== undefined) {
            const isPrivate = visibility !== AGENT_VISIBILITY.PUBLIC;
            const channel = isPrivate
              ? agentStatusChannelForAgent(message.workspaceId, message.agentId)
              : agentStatusChannel(message.workspaceId);
            await displayEvents.publishJson(channel, {
              type: "agent:display",
              ...snapshot,
            });
          }
        }
      }
      return new Uint8Array();
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "agent_service_tier:rejected",
          request_id: message.requestId,
          agent_id: message.agentId,
          workspace_id: metadata.principal.workspaceId,
          computer_id: metadata.principal.computerId,
          launch_id: message.launchId,
          reason: `unexpected: ${errorType(error)}`,
        }),
      );
      return { code: 403, message: "Agent service tier is not authorized" };
    }
  };
}
