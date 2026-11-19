import type { AgentAppConfigSync } from "#src/agent-app-config/agent-app-config-sync";
import type { AgentMigrationRunner } from "#src/agent-migration/migration-runner";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import type { SystemCleaner, SystemCleanerOptions } from "#src/system-cleaner/system-cleaner";
import type { DaemonConfig } from "./runtime";
import type { runtimeEnvelope } from "./runtime-envelope";
import type { CleanerInbox } from "#src/system-cleaner/system-cleaner";
import { AgentAppConfigSync as AppConfigSync } from "#src/agent-app-config/agent-app-config-sync";
import { AgentMigrationBucketClient } from "#src/connection/agent-migration-bucket-client";
import { AgentMigrationRunner as MigrationRunner } from "#src/agent-migration/migration-runner";
import { ProcJobManager } from "#src/proc-jobs/proc-job-manager";
import { FileReminderDueStore } from "#src/persistence/reminder-due-store";
import { ReminderDueReceiver } from "#src/agent-reminder/reminder-due-receiver";
import { ReminderAcknowledgementSync } from "#src/agent-reminder/reminder-acknowledgement-sync";
import { sendReminderAcknowledgement } from "./runtime-reminder-acknowledgement";
import {
  deliverReminderDue,
  wakeReminderDue,
  type RuntimeAgentApiRemindersPorts,
} from "./runtime-agent-api-reminders";
import { SystemCleaner as Cleaner } from "#src/system-cleaner/system-cleaner";
import { agentsDirectory, agentWorkspaceDirectory } from "#src/agent-runtime/agent-workspace-path";
import {
  UpgradeResultReporter,
  type RecoveredUpgradeResult,
  type UpgradeOperationsReading,
} from "./upgrade-result-reporter";
import type { RuntimePublicationSubscriptionPorts } from "./runtime-publication-subscriptions";
import type { UnrefTimerSchedule } from "./unref-timer";
import { ProviderQuotaState } from "./provider-quota-state";
import { CLEANER_APP_ID } from "@lrm/coforge-sdk/internal";

/** What the runtime supplies to one Workspace's reminder, cleaner, App config and migration work. */
export type RuntimeServicesPorts = {
  connection: DaemonConfig;
  stateDirectory: string;
  /** The Workspace's current transport, read at send time; it is replaced on each start. */
  transport(): DaemonConnectionClient;
  agentApiKeys: ReadonlyMap<string, string>;
  /** The Workspace envelope the App config snapshot request carries. */
  envelope(): ReturnType<typeof runtimeEnvelope>;
  /** The cleaner's inbox writes, as the inbox coordinator owns them. */
  cleanerInbox: Pick<CleanerInbox, "upsert" | "remove">;
  /** Whether the Agent is mid-turn: a busy one sees an item at its next idle drain. */
  isWorking(agentId: string): boolean;
  notifyAppItem(agentId: string, itemId: string): Promise<boolean>;
  reminderInbox(): RuntimeAgentApiRemindersPorts;
  /** The cleaner's host-injected clock and measurements. */
  systemCleaner: Pick<SystemCleanerOptions, "clock" | "measureMemoryFile" | "measureDiskSpace">;
  stopAgent(agentId: string): Promise<void>;
  runningAgentIds(): readonly string[];
  forgetLocalAgent(agentId: string): void;
  /** The Coordinator's upgrade-operation lifecycle, read by the result reporter: recovered
   * terminal results, the durable-operations reader it polls, its timer, and the server-side
   * acknowledgement. */
  upgradeResults?: {
    recoveredUpgradeResults?: RecoveredUpgradeResult[];
    readUpgradeOperations?(): Promise<UpgradeOperationsReading>;
    upgradeResultSchedule?: UnrefTimerSchedule;
    acknowledgeUpgradeResult?(requestId: string): Promise<void>;
  };
};

export type RuntimeServices = {
  reminders: ReminderDueReceiver;
  systemCleaner: SystemCleaner;
  appConfigs: AgentAppConfigSync;
  migrations: AgentMigrationRunner | undefined;
  upgradeResults: UpgradeResultReporter;
  procJobs: ProcJobManager;
  quotaState: ProviderQuotaState;
};

/**
 * Builds one Workspace runtime's background services: the cloud reminder schedule, the System
 * Cleaner and the App config sync it serves, and the Agent migration runner when the transport
 * offers that route. `DaemonRuntime` supplies the collaborators their ports call.
 */
export function composeRuntimeServices(ports: RuntimeServicesPorts): RuntimeServices {
  const { connection, stateDirectory, transport } = ports;
  const acknowledgementSync = new ReminderAcknowledgementSync((request) =>
    sendReminderAcknowledgement(
      request,
      ports.agentApiKeys,
      transport(),
      connection.workspaceId,
      connection.computerId,
    ),
  );
  const reminders = new ReminderDueReceiver(
    { workspaceId: connection.workspaceId, computerId: connection.computerId },
    new FileReminderDueStore(stateDirectory, connection.workspaceId, connection.computerId),
    {
      acknowledge: (request) => {
        const current = transport();
        if (!current.acknowledgeReminderDue) throw new Error("reminder due ACK is unavailable");
        return current.acknowledgeReminderDue(request);
      },
      deliver: (job, occurrence) => deliverReminderDue(ports.reminderInbox(), job, occurrence.late),
      wake: (agentId, itemId) => wakeReminderDue(ports.reminderInbox(), agentId, itemId),
      ...(ports.systemCleaner.clock ? { clock: ports.systemCleaner.clock } : {}),
      acknowledgeCloud: (request) => acknowledgementSync.enqueue(request),
    },
  );
  const systemCleaner = new Cleaner({
    ...ports.systemCleaner,
    agentsDirectory: agentsDirectory(connection.workspaceRoot, connection.workspaceId),
    inbox: ports.cleanerInbox,
    wake: async (agentId, itemId) => {
      // A busy Agent sees the item at its next idle drain; a stopped one at its next launch.
      if (ports.isWorking(agentId)) return;
      await ports.notifyAppItem(agentId, itemId);
    },
  });
  const appConfigs = new AppConfigSync({
    // `DaemonConnection#requestAppConfigSnapshot` implements this on every daemon connection; the
    // port stays optional for transports that carry no App config, and a sync only asks after the
    // server pushed a config through one that did, so the assertion holds where it is reached.
    requestSnapshot: (agentId) =>
      transport().requestAppConfigSnapshot!({
        ...ports.envelope(),
        agentId,
      }),
    apps: { [CLEANER_APP_ID]: systemCleaner },
  });
  // The transport is replaced on each start, so the runner reaches the route through whichever
  // one is current.
  const procJobs = new ProcJobManager({
    workspaceId: connection.workspaceId,
    workspaceRoot: connection.workspaceRoot,
    stateDirectory,
  });
  const migrations = transport().agentMigrationServer
    ? new MigrationRunner({
        server: () => transport().agentMigrationServer!(),
        bucket: new AgentMigrationBucketClient(),
        agents: {
          stop: async (agentId) => {
            await Promise.all([
              ports.stopAgent(agentId),
              procJobs.stopAllForAgent(agentId, "migrated"),
            ]);
          },
          isRunning: (agentId) => ports.runningAgentIds().includes(agentId),
          movedAway: (agentId) => ports.forgetLocalAgent(agentId),
        },
        workspaceDirectory: (agentId) =>
          agentWorkspaceDirectory(connection.workspaceRoot, connection.workspaceId, agentId),
        stateDirectory,
      })
    : undefined;
  const upgradeLifecycle = ports.upgradeResults ?? {};
  const recovered = { results: upgradeLifecycle.recoveredUpgradeResults ?? [], pending: false };
  const upgradeResults = new UpgradeResultReporter({
    workspaceId: connection.workspaceId,
    computerId: connection.computerId,
    readOperations: upgradeLifecycle.readUpgradeOperations ?? (async () => recovered),
    transport,
    acknowledge: upgradeLifecycle.acknowledgeUpgradeResult,
    schedule: upgradeLifecycle.upgradeResultSchedule,
  });
  const quotaState = new ProviderQuotaState();
  return { reminders, systemCleaner, appConfigs, migrations, upgradeResults, procJobs, quotaState };
}

/** The migration runner's operations as the publication subscriptions call them; absent when the
 * transport offers no migration route. */
export function migrationRoute(
  migrations: AgentMigrationRunner | undefined,
): RuntimePublicationSubscriptionPorts["migration"] {
  return migrations
    ? {
        pruneLeftovers: () => migrations.pruneLeftovers(),
        lease: (lease) => void migrations.lease(lease),
        cancel: (cancel) => migrations.cancel(cancel),
      }
    : undefined;
}
