import { daemonCapabilityLeases } from "./capability-composition.server";
import {
  AGENT_SESSION_METHOD,
  AGENT_SESSION_INVALIDATE_METHOD,
  AGENT_CONTEXT_USAGE_METHOD,
  AGENT_SERVICE_TIER_METHOD,
  WORKSPACE_LIST_METHOD,
  AGENT_SKILLS_LIST_RESULT_METHOD,
  AGENT_WORKSPACE_FILES_LIST_RESULT_METHOD,
  AGENT_WORKSPACE_FILE_READ_RESULT_METHOD,
  AGENT_WORKSPACE_DELETE_RESULT_METHOD,
  AGENT_CONTROL_RESULT_METHOD,
  REMINDER_FIRE_METHOD,
  REMINDER_SNAPSHOT_METHOD,
  APP_CONFIG_SNAPSHOT_METHOD,
} from "@lrm/coforge-sdk/internal";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { PI_CHAT_FRAME_METHOD } from "@lrm/coforge-sdk/internal/pi-chat-wire";
import { createPiChatFrameMethod } from "#src/server/pi-chat/pi-chat-frame-receiver.server";
import { canUsePiChat, getPiChatResults } from "#src/server/pi-chat/pi-chat-production.server";
import { createAgentSkillsListResultMethod } from "./agent-skills-cache.server";
import {
  createAgentWorkspaceFileReadResultMethod,
  createAgentWorkspaceFilesListResultMethod,
  createAgentWorkspaceDeleteResultMethod,
} from "./agent-workspace-files-cache.server";

import {
  CentrifugoRpcHandler,
  CentrifugoRpcAuthenticationError,
  type CentrifugoRpcError,
  type CentrifugoRpcMethod,
} from "./rpc-handler.server";
import { getDatabaseClient } from "#src/server/db/client.server";
import type { PrismaClient } from "#src/generated/prisma/client";
import { PrismaWorkspaceAccess } from "#src/server/db/repositories/setup.repositories.server";
import {
  createAgentSessionMethod,
  createAgentSessionInvalidateMethod,
  createWorkspaceListMethod,
  createDaemonRuntimeReadyMethod,
  createDaemonRuntimeUsageScanResultMethod,
  createDaemonRuntimeProviderModelRefreshResultMethod,
  createAgentContextScanResultMethod,
  createComputerUpgradeResultMethod,
  createDaemonConnectionStatusMethod,
  createDaemonRuntimeShutdownMethod,
  createAgentStatusMethod,
  createReminderFireMethod,
  createReminderSnapshotMethod,
  createAppConfigSnapshotMethod,
} from "./rpc-handler.server";
import {
  DAEMON_RUNTIME_READY_METHOD,
  DAEMON_RUNTIME_SHUTDOWN_METHOD,
  DAEMON_RUNTIME_USAGE_SCAN_RESULT_METHOD,
  DAEMON_RUNTIME_MODEL_REFRESH_RESULT_METHOD,
  AGENT_CONTEXT_SCAN_RESULT_METHOD,
  COMPUTER_UPGRADE_RESULT_METHOD,
  DAEMON_CONNECTION_STATUS_METHOD,
  AGENT_STATUS_METHOD,
} from "@lrm/coforge-sdk/internal";
import { WorkspaceQueryUseCase } from "#src/server/workspaces/query.server";
import { getComputerRestartStore } from "#src/server/computers/computer-restart-store.server";
import { getComputerUpgradeStore } from "#src/server/computers/computer-upgrade-store.server";
import { recordComputerObservation } from "#src/server/computers/computer-metadata.server";
import { ComputerLifecycleActivity } from "#src/server/agents/computer-lifecycle-activity.server";
import { getComputerLifecycleMemory } from "#src/server/computers/computer-lifecycle-memory.server";
import { AgentActivityRepository } from "#src/server/db/repositories/agent-activity.repositories.server";
import {
  PrismaAgentRepository,
  RepositoryAgentAuthorization,
} from "#src/server/db/repositories/agent.repositories.server";
import {
  createAgentStartMethod,
  createAgentDeliveryAckMethod,
  createAgentDeliveryRejectMethod,
  createMentionDeliveryTerminalErrorMethod,
  createMentionDeliveryTransitionMethod,
} from "./rpc-handler.server";
import { AgentDeliveryRejections } from "#src/server/agents/agent-delivery-rejection.server";
import { agentMigrationOrchestrator } from "#src/server/agent-migrations/agent-migration-composition.server";
import { MentionDeliveryReports } from "#src/server/conversations/mention-deliveries.server";
import { PrismaMentionDeliveryRepository } from "#src/server/db/repositories/mention-delivery.repositories.server";
import {
  PublishAgentRuntimeControl,
  WorkspaceAgentRecovery,
} from "#src/server/agents/agent-runtime-control.server";
import { getAgentRuntimeLock } from "#src/server/agents/agent-runtime-lock.server";
import { AgentControl } from "#src/server/agents/agent-control.server";
import { getAgentControlSignal } from "#src/server/agents/agent-control-signal.server";
import { PrismaAgentControlStore } from "#src/server/db/repositories/agent-control.repositories.server";
import { createCentrifugoServerApi } from "./server-api.server";
import {
  AGENT_START_METHOD,
  AGENT_MESSAGE_ACK_METHOD,
  AGENT_MESSAGE_REJECT_METHOD,
  AGENT_MENTION_DELIVERY_TERMINAL_ERROR_METHOD,
  AGENT_MENTION_DELIVERY_TRANSITION_METHOD,
} from "@lrm/coforge-sdk/internal";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { verifyDaemonApiKey } from "#src/server/auth/daemon-api-key.server";
import {
  authenticateAgentApiKey,
  isAgentApiKeyBoundToComputer,
} from "#src/server/agents/agent-api-key.server";
import { PrismaAgentApiKeyRepository } from "#src/server/db/repositories/agent-api-key.repositories.server";
import { PrismaDaemonApiKeyRepository } from "#src/server/db/repositories/daemon-api-key.repositories.server";
import { createAgentIntroduction } from "#src/server/db/repositories/agent-introduction.repositories.server";
import { createAgentSessions } from "#src/server/db/repositories/agent-session.repositories.server";
import { AgentSessionReceiver } from "#src/server/agents/agent-session.server";
import { createAgentControlResultMethod } from "./agent-control-receiver.server";
import { computerRuntimeMethods } from "./runtime-auth-report-receiver.server";
import { daemonReportMethods } from "./daemon-report-methods.server";
import { agentReadingMethods } from "./agent-reading-methods";
import { PrismaReminderRepository } from "#src/server/db/repositories/reminder.repositories.server";
import { Reminders } from "#src/server/reminders/reminders.server";
import { createAgentAppConfigs } from "#src/server/agent-app-configs/agent-app-configs-composition.server";
import { daemonControlChannel } from "./server-api.server";
import { encodeReminderSync } from "@lrm/coforge-sdk/internal";
import { getAgentDisplay } from "#src/server/agents/agent-display.server";
import { registerBackgroundSweeps } from "#src/server/sweeps/background-sweeps.server";

const unavailable: CentrifugoRpcError = {
  code: 503,
  message: "protocol method dependencies are unavailable",
};

/**
 * The reminder callbacks a Computer calls back on, under their current names.
 *
 * The upgrade window that also answered the pre-convention `reminder:v1:*` spellings is closed: the
 * rename to `agent:v1:reminder:*` shipped before 0.1.0, and no supported Computer sends the old
 * names. A Computer that does is unsupported and sees Centrifugo's `104`, not a silent miss.
 */
export function reminderCallbackMethods(
  fire: CentrifugoRpcMethod,
  snapshot: CentrifugoRpcMethod,
): Record<string, CentrifugoRpcMethod> {
  return {
    [REMINDER_FIRE_METHOD]: fire,
    [REMINDER_SNAPSHOT_METHOD]: snapshot,
  };
}

const unavailableMethod: CentrifugoRpcMethod = () => unavailable;

async function requireAuthenticatedCentrifugoUser(
  request: { user?: string; meta?: Record<string, unknown> },
  context: Request,
  daemonApiKeys: import("#src/server/auth/daemon-api-key.server").DaemonApiKeyRepository,
) {
  const daemonHeader = context.headers.get("authorization");
  if (daemonHeader?.startsWith("Bearer ")) {
    try {
      return await verifyDaemonApiKey(daemonHeader.slice("Bearer ".length).trim(), daemonApiKeys);
    } catch {
      const db = getDatabaseClient();
      if (db) {
        try {
          const agentHeader = context.headers.get("x-coforge-agent-api-key");
          if (!agentHeader?.startsWith("Bearer ")) throw new Error("Agent API key missing");
          const record = await authenticateAgentApiKey(
            agentHeader.slice("Bearer ".length).trim(),
            new PrismaAgentApiKeyRepository(db),
          );
          const daemon = await verifyDaemonApiKey(
            daemonHeader.slice("Bearer ".length).trim(),
            daemonApiKeys,
          );
          if (
            !isAgentApiKeyBoundToComputer(record, daemon) ||
            !(await db.workspaceComputer.findUnique({
              where: {
                workspaceId_computerId: {
                  workspaceId: daemon.workspaceId,
                  computerId: daemon.computerId,
                },
              },
              select: { id: true },
            }))
          )
            throw new Error("daemon credential scope mismatch");
          return {
            userId: record.ownerId,
            workspaceId: record.workspaceId,
            computerId: daemon.computerId,
            agentId: record.agentId,
          };
        } catch {
          // Keep malformed and revoked credentials indistinguishable.
        }
      }
      throw new CentrifugoRpcAuthenticationError();
    }
  }
  const workspaceId = request.meta?.workspace_id;
  const computerId = request.meta?.computer_id;
  if (
    request.user &&
    typeof workspaceId === "string" &&
    typeof computerId === "string" &&
    workspaceId &&
    computerId
  )
    return { userId: request.user, workspaceId, computerId };
  // User-facing calls use Centrifugo's verified user subject. Daemon-scoped
  // methods still fail closed because their required claims are empty.
  if (!request.user) throw new CentrifugoRpcAuthenticationError();
  return { userId: request.user, workspaceId: "", computerId: "" };
}

function authorizeCentrifugoProxy(request: Request): void {
  const secret = process.env.COFORGE_CENTRIFUGO_PROXY_SECRET;
  if (!secret || request.headers.get("x-coforge-centrifugo-proxy-secret") !== secret)
    throw new Error("proxy authorization failed");
}

/**
 * Compose the server-owned Centrifugo boundary without inventing persistence.
 *
 * `db` is a parameter so tests can compose the unwired handler by passing
 * `null`, rather than depending on DATABASE_URL being absent from the
 * environment.
 */
export function createCentrifugoRpcHandler(db: PrismaClient | null = getDatabaseClient() ?? null) {
  if (db) {
    const access = new PrismaWorkspaceAccess(db);
    const query = new WorkspaceQueryUseCase(access);
    const agentRepository = new PrismaAgentRepository(db);
    const agentAuthorization = new RepositoryAgentAuthorization(agentRepository);
    const centrifugo = createCentrifugoServerApi();
    // Real traffic: idempotent per process, inert until this composition runs.
    registerBackgroundSweeps();
    const controlStore = new PrismaAgentControlStore(db);
    const directConversations = new PrismaDirectConversationRepository(db);
    const mentionReports = new MentionDeliveryReports(
      new PrismaMentionDeliveryRepository(db),
      centrifugo,
      directConversations,
    );
    const sessions = createAgentSessions(db, mentionReports);
    const control = new AgentControl(
      controlStore,
      centrifugo,
      getAgentRuntimeLock(),
      undefined,
      sessions,
      getAgentControlSignal(),
      directConversations,
      mentionReports,
      createAgentIntroduction(db),
    );
    const sessionReceiver = new AgentSessionReceiver(
      controlStore,
      async (workspaceId, computerId) =>
        (await getComputerRestartStore().identity?.({ workspaceId, computerId }))?.workerInstanceId,
      mentionReports,
    );
    const reminderRepository = new PrismaReminderRepository(db);
    const { reminderLease, capabilityLeases } = daemonCapabilityLeases();
    const appConfigs = createAgentAppConfigs(db, centrifugo);
    const reminders = new Reminders(reminderRepository, reminderLease, (sync) =>
      centrifugo.publish(
        daemonControlChannel(sync.workspaceId, sync.computerId),
        encodeReminderSync(sync),
      ),
    );
    const agentActivity = new AgentActivityRepository(db);
    const computerLifecycle = new ComputerLifecycleActivity({
      agents: ({ workspaceId, computerId }) =>
        agentRepository.listVisibilityForComputer(workspaceId, computerId),
      record: (activities) => agentActivity.recordMany(activities),
      publish: (channel, data) => centrifugo.publish(channel, data),
      memory: getComputerLifecycleMemory(),
      upgradeStatus: (scope, requestId) => getComputerUpgradeStore().status(scope, requestId),
      restartStatus: (scope, requestId) => getComputerRestartStore().status(scope, requestId),
    });
    return new CentrifugoRpcHandler({
      methods: {
        [PI_CHAT_FRAME_METHOD]: createPiChatFrameMethod({
          canUse: (scope) => canUsePiChat(db, scope),
          results: getPiChatResults(),
          publish: (channel, bytes) => centrifugo.publish(channel, bytes),
        }),
        [AGENT_SESSION_METHOD]: createAgentSessionMethod(sessions, sessionReceiver),
        [AGENT_SESSION_INVALIDATE_METHOD]: createAgentSessionInvalidateMethod(sessionReceiver),
        ...agentReadingMethods({
          agents: controlStore,
          display: getAgentDisplay(),
          events: centrifugo,
          db,
        }),
        [WORKSPACE_LIST_METHOD]: createWorkspaceListMethod(query),
        [DAEMON_RUNTIME_READY_METHOD]: createDaemonRuntimeReadyMethod({
          recovery: new WorkspaceAgentRecovery(
            agentRepository,
            directConversations,
            centrifugo,
            getAgentRuntimeLock(),
            mentionReports,
            sessions,
            control,
            controlStore,
          ),
          restarts: getComputerRestartStore(),
          capabilities: capabilityLeases,
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
          lifecycle: computerLifecycle,
        }),
        [DAEMON_RUNTIME_SHUTDOWN_METHOD]: createDaemonRuntimeShutdownMethod(
          computerLifecycle,
          async (scope) => (await getComputerRestartStore().identity?.(scope))?.workerInstanceId,
        ),
        ...reminderCallbackMethods(
          createReminderFireMethod(reminders),
          createReminderSnapshotMethod(reminders),
        ),
        [APP_CONFIG_SNAPSHOT_METHOD]: createAppConfigSnapshotMethod(appConfigs),
        [DAEMON_CONNECTION_STATUS_METHOD]: createDaemonConnectionStatusMethod(
          undefined,
          capabilityLeases,
          getComputerUpgradeStore(),
        ),
        ...computerRuntimeMethods(db),
        [DAEMON_RUNTIME_USAGE_SCAN_RESULT_METHOD]: createDaemonRuntimeUsageScanResultMethod(),
        [DAEMON_RUNTIME_MODEL_REFRESH_RESULT_METHOD]:
          createDaemonRuntimeProviderModelRefreshResultMethod(),
        [AGENT_CONTEXT_SCAN_RESULT_METHOD]: createAgentContextScanResultMethod(),
        [COMPUTER_UPGRADE_RESULT_METHOD]:
          createComputerUpgradeResultMethod(getComputerUpgradeStore()),
        [AGENT_SKILLS_LIST_RESULT_METHOD]: createAgentSkillsListResultMethod(),
        [AGENT_WORKSPACE_FILES_LIST_RESULT_METHOD]: createAgentWorkspaceFilesListResultMethod(),
        [AGENT_WORKSPACE_FILE_READ_RESULT_METHOD]: createAgentWorkspaceFileReadResultMethod(),
        [AGENT_WORKSPACE_DELETE_RESULT_METHOD]: createAgentWorkspaceDeleteResultMethod(),
        [AGENT_CONTROL_RESULT_METHOD]: createAgentControlResultMethod(control),
        ...daemonReportMethods(db),
        [AGENT_START_METHOD]: createAgentStartMethod(
          new PublishAgentRuntimeControl(
            agentAuthorization,
            centrifugo,
            async () => {},
            sessions,
            control,
          ),
        ),
        [AGENT_STATUS_METHOD]: createAgentStatusMethod(
          agentRepository,
          undefined,
          centrifugo,
          Date.now,
          getAgentDisplay(),
          centrifugo,
        ),
        [AGENT_MESSAGE_ACK_METHOD]: createAgentDeliveryAckMethod(mentionReports),
        [AGENT_MESSAGE_REJECT_METHOD]: createAgentDeliveryRejectMethod(
          new AgentDeliveryRejections(
            controlStore,
            directConversations,
            getAgentRuntimeLock(),
            control,
          ),
        ),
        [AGENT_MENTION_DELIVERY_TRANSITION_METHOD]:
          createMentionDeliveryTransitionMethod(mentionReports),
        [AGENT_MENTION_DELIVERY_TERMINAL_ERROR_METHOD]:
          createMentionDeliveryTerminalErrorMethod(mentionReports),
      },
      authenticateEnvelope: (request, context) =>
        requireAuthenticatedCentrifugoUser(request, context, new PrismaDaemonApiKeyRepository(db)),
      authorizeProxyRequest: authorizeCentrifugoProxy,
    });
  }
  return new CentrifugoRpcHandler({
    methods: {
      [WORKSPACE_LIST_METHOD]: unavailableMethod,
      [DAEMON_RUNTIME_READY_METHOD]: createDaemonRuntimeReadyMethod(),
      [DAEMON_RUNTIME_SHUTDOWN_METHOD]: unavailableMethod,
      [DAEMON_CONNECTION_STATUS_METHOD]: createDaemonConnectionStatusMethod(),
      ...computerRuntimeMethods(null),
      [DAEMON_RUNTIME_USAGE_SCAN_RESULT_METHOD]: createDaemonRuntimeUsageScanResultMethod(),
      [DAEMON_RUNTIME_MODEL_REFRESH_RESULT_METHOD]:
        createDaemonRuntimeProviderModelRefreshResultMethod(),
      [AGENT_CONTEXT_SCAN_RESULT_METHOD]: createAgentContextScanResultMethod(),
      [COMPUTER_UPGRADE_RESULT_METHOD]: unavailableMethod,
      [AGENT_SKILLS_LIST_RESULT_METHOD]: unavailableMethod,
      [AGENT_WORKSPACE_FILES_LIST_RESULT_METHOD]: unavailableMethod,
      [AGENT_WORKSPACE_FILE_READ_RESULT_METHOD]: unavailableMethod,
      [AGENT_WORKSPACE_DELETE_RESULT_METHOD]: unavailableMethod,
      [AGENT_CONTROL_RESULT_METHOD]: unavailableMethod,
      ...daemonReportMethods(null),
      [AGENT_SESSION_METHOD]: unavailableMethod,
      [AGENT_SESSION_INVALIDATE_METHOD]: unavailableMethod,
      [AGENT_CONTEXT_USAGE_METHOD]: unavailableMethod,
      [AGENT_SERVICE_TIER_METHOD]: unavailableMethod,
      [AGENT_START_METHOD]: unavailableMethod,
      [AGENT_STATUS_METHOD]: unavailableMethod,
      [AGENT_MESSAGE_ACK_METHOD]: unavailableMethod,
      [AGENT_MESSAGE_REJECT_METHOD]: unavailableMethod,
      [AGENT_MENTION_DELIVERY_TRANSITION_METHOD]: unavailableMethod,
      [AGENT_MENTION_DELIVERY_TERMINAL_ERROR_METHOD]: unavailableMethod,
      ...reminderCallbackMethods(unavailableMethod, unavailableMethod),
      [APP_CONFIG_SNAPSHOT_METHOD]: unavailableMethod,
    },
    authenticateEnvelope: (request, context) =>
      requireAuthenticatedCentrifugoUser(request, context, {
        replaceActive: async () => {},
        findByHash: async () => undefined,
        markUsed: async () => {},
      }),
    authorizeProxyRequest: authorizeCentrifugoProxy,
  });
}
