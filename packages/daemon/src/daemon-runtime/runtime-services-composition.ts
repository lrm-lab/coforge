import type { AgentAppConfigSync } from "#src/agent-app-config/agent-app-config-sync";
import type { AgentMigrationRunner } from "#src/agent-migration/migration-runner";
import type { ReminderScheduler } from "#src/agent-reminder/reminder-scheduler";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import type { SystemCleaner, SystemCleanerOptions } from "#src/system-cleaner/system-cleaner";
import type { ReminderJob } from "@lrm/coforge-sdk/internal";
import type { DaemonConfig } from "./runtime";
import type { runtimeEnvelope } from "./runtime-envelope";
import type { CleanerInbox } from "#src/system-cleaner/system-cleaner";
import { AgentAppConfigSync as AppConfigSync } from "#src/agent-app-config/agent-app-config-sync";
import { AgentMigrationBucketClient } from "#src/connection/agent-migration-bucket-client";
import { AgentMigrationRunner as MigrationRunner } from "#src/agent-migration/migration-runner";
import { FileReminderReceiptStore } from "#src/persistence/reminder-receipt-store";
import { ReminderScheduler as Reminders } from "#src/agent-reminder/reminder-scheduler";
import { SystemCleaner as Cleaner } from "#src/system-cleaner/system-cleaner";
import { agentsDirectory, agentWorkspaceDirectory } from "#src/agent-runtime/agent-workspace-path";
import {
  UpgradeResultReporter,
  type RecoveredUpgradeResult,
  type UpgradeOperationsReading,
} from "./upgrade-result-reporter";
import type { UnrefTimerSchedule } from "./unref-timer";
import { CLEANER_APP_ID } from "@lrm/coforge-sdk/internal";

/** What the runtime supplies to one Workspace's reminder, cleaner, App config and migration work. */
export type RuntimeServicesPorts = {
  connection: DaemonConfig;
  stateDirectory: string;
  /** The Workspace's current transport, read at send time; it is replaced on each start. */
  transport(): DaemonConnectionClient;
  /** The Workspace envelope the App config snapshot request carries. */
  envelope(): ReturnType<typeof runtimeEnvelope>;
  /** The cleaner's inbox writes, as the inbox coordinator owns them. */
  cleanerInbox: Pick<CleanerInbox, "upsert" | "remove">;
  /** Whether the Agent is mid-turn: a busy one sees an item at its next idle drain. */
  isWorking(agentId: string): boolean;
  notifyAppItem(agentId: string, itemId: string): Promise<boolean>;
  /** The reminder job that came due, delivered through the Agent's wake path. */
  acceptReminderDue(job: ReminderJob, late: boolean): Promise<boolean>;
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
  reminders: ReminderScheduler;
  systemCleaner: SystemCleaner;
  appConfigs: AgentAppConfigSync;
  migrations: AgentMigrationRunner | undefined;
  upgradeResults: UpgradeResultReporter;
};

/**
 * Builds one Workspace runtime's background services: the cloud reminder schedule, the System
 * Cleaner and the App config sync it serves, and the Agent migration runner when the transport
 * offers that route. `DaemonRuntime` supplies the collaborators their ports call.
 */
export function composeRuntimeServices(ports: RuntimeServicesPorts): RuntimeServices {
  const { connection, stateDirectory, transport } = ports;
  const reminders = new Reminders(
    { workspaceId: connection.workspaceId, computerId: connection.computerId },
    new FileReminderReceiptStore(stateDirectory, connection.workspaceId, connection.computerId),
    (request) => {
      const current = transport();
      if (!current.fireReminder) throw new Error("reminder fire is unavailable");
      return current.fireReminder(request);
    },
    (job: ReminderJob, occurrence: { late: boolean }) =>
      ports.acceptReminderDue(job, occurrence.late),
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
  const migrations = transport().agentMigrationServer
    ? new MigrationRunner({
        server: () => transport().agentMigrationServer!(),
        bucket: new AgentMigrationBucketClient(),
        agents: {
          stop: (agentId) => ports.stopAgent(agentId),
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
    computerId: connection.computerId ?? "",
    readOperations: upgradeLifecycle.readUpgradeOperations ?? (async () => recovered),
    transport,
    acknowledge: upgradeLifecycle.acknowledgeUpgradeResult,
    schedule: upgradeLifecycle.upgradeResultSchedule,
  });
  return { reminders, systemCleaner, appConfigs, migrations, upgradeResults };
}
