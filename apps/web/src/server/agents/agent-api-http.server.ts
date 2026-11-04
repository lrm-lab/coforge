import { encodeReminderSync } from "@lrm/coforge-sdk/internal";

import {
  AgentApiKeyError,
  authenticateAgentApiKey,
  isAgentApiKeyBoundToComputer,
  settleAgentApiKeyFirstUse,
  type AgentApiKeyAuthFailure,
  type AgentApiKeyRepository,
} from "./agent-api-key.server";
import { verifyDaemonApiKey } from "#src/server/auth/daemon-api-key.server";
import type { PrismaClient } from "#src/generated/prisma/client";
import { getDatabaseClient } from "#src/server/db/client.server";
import { PrismaAgentApiKeyRepository } from "#src/server/db/repositories/agent-api-key.repositories.server";
import { PrismaDaemonApiKeyRepository } from "#src/server/db/repositories/daemon-api-key.repositories.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoRpcAuthenticationError } from "#src/server/centrifugo/rpc-handler.server";
import { ACTIVE_AGENT_WHERE } from "./active-agent.server";
import { WORKSPACE_ASSISTANT_KIND } from "#src/features/agents/agent-system-kind";
import { PrismaReminderRepository } from "#src/server/db/repositories/reminder.repositories.server";
import { Reminders } from "#src/server/reminders/reminders.server";
import { getReminderCapabilityLease } from "#src/server/reminders/reminder-capability.server";
import { daemonControlChannel } from "#src/server/centrifugo/server-api.server";

type DaemonPrincipal = {
  userId: string;
  workspaceId: string;
  computerId: string;
};

/** The 401 warning: the request id only when the caller sent a real UUID — it is
 * client-supplied and otherwise unbounded. Key material never appears here. */
function warnAuthFailed(request: Request, reason: AgentApiKeyAuthFailure): void {
  const requestId = request.headers.get("x-request-id");
  console.warn(
    JSON.stringify({
      event: "agent_http.auth_failed",
      request_id:
        requestId &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)
          ? requestId
          : undefined,
      reason,
    }),
  );
}

export async function authenticateAgentMessageRequest(
  request: Request,
  dependencies: {
    agentApiKeys: AgentApiKeyRepository;
    verifyDaemonApiKey(token: string): Promise<DaemonPrincipal>;
    computerBelongsToWorkspace(workspaceId: string, computerId: string): Promise<boolean>;
    agentIsActive(workspaceId: string, agentId: string): Promise<boolean>;
  },
) {
  try {
    const daemonAuthorization = request.headers.get("authorization");
    const agentAuthorization = request.headers.get("x-coforge-agent-api-key");
    if (!agentAuthorization?.startsWith("Bearer ") || !daemonAuthorization?.startsWith("Bearer "))
      throw new AgentApiKeyError("key_not_found");
    // Every Agent HTTP call runs this before its route, so the reads that do not depend on each
    // other go out together: both keys, then the Computer's and the Agent's scope.
    const [record, daemon] = await Promise.all([
      authenticateAgentApiKey(agentAuthorization.slice(7).trim(), dependencies.agentApiKeys),
      dependencies
        .verifyDaemonApiKey(daemonAuthorization.slice(7).trim())
        .catch((error: unknown) => {
          throw error instanceof AgentApiKeyError
            ? error
            : new AgentApiKeyError("daemon_key_invalid");
        }),
    ]);
    if (!isAgentApiKeyBoundToComputer(record, daemon)) throw new AgentApiKeyError("scope_mismatch");
    const [computerInWorkspace, agentActive] = await Promise.all([
      dependencies.computerBelongsToWorkspace(daemon.workspaceId, daemon.computerId),
      // Deleting an Agent revokes its keys, but a key minted before the delete could still be
      // in flight; check the Agent itself so a deleted Agent can never act through the HTTP API.
      dependencies.agentIsActive(record.workspaceId, record.agentId),
    ]);
    if (!computerInWorkspace || !agentActive) throw new AgentApiKeyError("scope_mismatch");
    // The overlap settle writes only after every check passed — a refused request retires no
    // key — and a settle failure must not turn an authenticated request into a 401.
    try {
      await settleAgentApiKeyFirstUse(record, dependencies.agentApiKeys);
    } catch {
      warnAuthFailed(request, "internal");
    }
    return {
      userId: record.ownerId,
      workspaceId: record.workspaceId,
      computerId: daemon.computerId,
      agentId: record.agentId,
    };
  } catch (error) {
    warnAuthFailed(request, error instanceof AgentApiKeyError ? error.reason : "internal");
    throw new CentrifugoRpcAuthenticationError();
  }
}

export function createAgentReminderService(
  db: NonNullable<ReturnType<typeof getDatabaseClient>>,
  centrifugo = createCentrifugoServerApi(),
) {
  return new Reminders(new PrismaReminderRepository(db), getReminderCapabilityLease(), (sync) =>
    centrifugo.publish(
      daemonControlChannel(sync.workspaceId, sync.computerId),
      encodeReminderSync(sync),
    ),
  );
}

export async function authenticateAgentHttpRequest(request: Request, db: PrismaClient) {
  return authenticateAgentMessageRequest(request, {
    agentApiKeys: new PrismaAgentApiKeyRepository(db),
    verifyDaemonApiKey: (token) => verifyDaemonApiKey(token, new PrismaDaemonApiKeyRepository(db)),
    computerBelongsToWorkspace: async (workspaceId, computerId) =>
      Boolean(
        await db.workspaceComputer.findUnique({
          where: { workspaceId_computerId: { workspaceId, computerId } },
          select: { id: true },
        }),
      ),
    agentIsActive: async (workspaceId, agentId) => {
      const agent = await db.agent.findFirst({
        where: { id: agentId, workspaceId, ...ACTIVE_AGENT_WHERE },
        select: {
          systemKind: true,
          owner: { select: { memberships: { where: { workspaceId }, select: { userId: true } } } },
        },
      });
      return Boolean(
        agent &&
        (agent.systemKind !== WORKSPACE_ASSISTANT_KIND || agent.owner.memberships.length > 0),
      );
    },
  });
}
