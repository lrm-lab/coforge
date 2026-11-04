import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import type { PrismaClient } from "#src/generated/prisma/client";
import { WorkspaceAgentRecovery } from "#src/server/agents/agent-runtime-control.server";
import { createDaemonRuntimeReadyMethod } from "#src/server/centrifugo/daemon-runtime-ready-method.server";
import { getComputerRestartStore } from "#src/server/computers/computer-restart-store.server";
import { getComputerUpgradeStore } from "#src/server/computers/computer-upgrade-store.server";
import { recordComputerObservation } from "#src/server/computers/computer-metadata.server";
import { readLatestComputerVersion } from "#src/server/computers/latest-computer-version.server";
import { resolveReleaseFeedUrl } from "#src/server/install/install-script.server";
import { agentMigrationOrchestrator } from "#src/server/agent-migrations/agent-migration-composition.server";
import { daemonControlChannel } from "./server-api.server";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import type { Reminders } from "#src/server/reminders/reminders.server";
import type { PrismaAgentRepository } from "#src/server/db/repositories/agent.repositories.server";
import type { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import type { MentionDeliveryReports } from "#src/server/conversations/mention-deliveries.server";
import type { createAgentSessions } from "#src/server/db/repositories/agent-session.repositories.server";
import type { AgentControl } from "#src/server/agents/agent-control.server";
import type { PrismaAgentControlStore } from "#src/server/db/repositories/agent-control.repositories.server";
import type { getAgentRuntimeLock } from "#src/server/agents/agent-runtime-lock.server";
import type { daemonCapabilityLeases } from "./capability-composition.server";
import type { ComputerLifecycleActivity } from "#src/server/agents/computer-lifecycle-activity.server";

/** The ready method's ports, assembled beside the composition so the file's `createDaemon*
 * table stays a list of names rather than one method's dependency graph. */
export function daemonRuntimeReadyPorts(input: {
  db: PrismaClient;
  centrifugo: CentrifugoServerApi;
  agentRepository: PrismaAgentRepository;
  directConversations: PrismaDirectConversationRepository;
  mentionReports: MentionDeliveryReports;
  sessions: ReturnType<typeof createAgentSessions>;
  control: AgentControl;
  controlStore: PrismaAgentControlStore;
  agentRuntimeLock: ReturnType<typeof getAgentRuntimeLock>;
  reminders: Reminders;
  capabilityLeases: ReturnType<typeof daemonCapabilityLeases>["capabilityLeases"];
  computerLifecycle: ComputerLifecycleActivity;
}): Parameters<typeof createDaemonRuntimeReadyMethod>[0] {
  const { db, centrifugo, reminders } = input;
  return {
    latestComputerVersion: () => {
      const feedUrl = resolveReleaseFeedUrl();
      return feedUrl ? readLatestComputerVersion(feedUrl) : Promise.resolve(null);
    },
    recovery: new WorkspaceAgentRecovery(
      input.agentRepository,
      input.directConversations,
      centrifugo,
      input.agentRuntimeLock,
      input.mentionReports,
      input.sessions,
      input.control,
      input.controlStore,
    ),
    restarts: getComputerRestartStore(),
    capabilities: input.capabilityLeases,
    reminderRecovery: {
      snapshotAssigned: async (workspaceId, computerId) => {
        const agents = await db.agent.findMany({
          where: { workspaceId, computerId, ...ACTIVE_AGENT_WHERE },
          select: { id: true, ownerId: true },
        });
        await Promise.all(
          agents.map(async (agent) => {
            const bytes = await reminders.snapshot({
              protocolMajor: 1,
              requestId: crypto.randomUUID(),
              workspaceId,
              computerId,
              agentId: agent.id,
              userId: agent.ownerId,
            });
            await centrifugo.publish(daemonControlChannel(workspaceId, computerId), bytes);
          }),
        );
      },
    },
    migrationRecovery: {
      recover: (workspaceId, computerId) =>
        agentMigrationOrchestrator(db).recover(workspaceId, computerId),
    },
    observe: (scope, observation) => recordComputerObservation(db, scope, observation),
    upgrades: getComputerUpgradeStore(),
    lifecycle: input.computerLifecycle,
  };
}
