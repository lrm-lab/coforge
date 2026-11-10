import {
  AGENT_CREDENTIAL_RESTORED_METHOD,
  decodeAgentCredentialRestored,
} from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import { CredentialRestoredActivity } from "#src/server/agents/credential-restored-activity.server";
import { AgentActivityRepository } from "#src/server/db/repositories/agent-activity.repositories.server";
import { PrismaAgentRepository } from "#src/server/db/repositories/agent.repositories.server";
import type { CentrifugoRpcMethod } from "./rpc-handler.server";
import { rejectNonDaemonPrincipal } from "./daemon-principal.server";
import { createCentrifugoServerApi } from "./server-api.server";
import { rejectionReason } from "./rejection-reason.server";

const KNOWN_REJECTION_REASONS = new Set([
  "invalid credential restored",
  "credential restored payload too large",
]);

/**
 * A daemon's report that an Agent's provider credential works again: fire-and-forget, answered 403
 * on any rejection and logged with an allowlisted reason, like the other daemon reports.
 */
export function createAgentCredentialRestoredMethod(
  restored: Pick<CredentialRestoredActivity, "receive">,
): CentrifugoRpcMethod {
  return async (payload, { principal }) => {
    const rejection = rejectNonDaemonPrincipal(principal);
    if (rejection) return rejection;
    try {
      const report = decodeAgentCredentialRestored(payload);
      if (principal.workspaceId !== report.workspaceId)
        return { code: 403, message: "credential restored scope is not authorized" };
      if (
        !(await restored.receive(
          { workspaceId: report.workspaceId, computerId: principal.computerId },
          report,
        ))
      )
        return { code: 403, message: "credential restored scope is not authorized" };
      return new Uint8Array();
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "credential_restored:rejected",
          workspace_id: principal.workspaceId,
          computer_id: principal.computerId,
          reason: rejectionReason(error, KNOWN_REJECTION_REASONS),
        }),
      );
      return { code: 403, message: "credential restored is not authorized" };
    }
  };
}

/** The report method, or the 503 stub when the server composes without a database. */
export function agentCredentialRestoredMethods(
  db: PrismaClient | null,
): Record<string, CentrifugoRpcMethod> {
  if (!db)
    return {
      [AGENT_CREDENTIAL_RESTORED_METHOD]: () => ({
        code: 503,
        message: "protocol method dependencies are unavailable",
      }),
    };
  const activity = new AgentActivityRepository(db);
  const agents = new PrismaAgentRepository(db);
  return {
    [AGENT_CREDENTIAL_RESTORED_METHOD]: createAgentCredentialRestoredMethod(
      new CredentialRestoredActivity({
        agents: ({ workspaceId, computerId }) =>
          agents.listVisibilityForComputer(workspaceId, computerId),
        newest: (workspaceId, agentId) => activity.newest(workspaceId, agentId),
        record: (activities) => activity.recordMany(activities),
        publish: (channel, data) => createCentrifugoServerApi().publish(channel, data),
      }),
    ),
  };
}
