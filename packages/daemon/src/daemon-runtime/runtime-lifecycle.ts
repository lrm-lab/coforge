import type { DaemonConnectRejectionReason } from "@lrm/coforge-sdk/internal";
import type { RecoveredUpgradeResult, UpgradeOperationsReading } from "./upgrade-result-reporter";
import type { UnrefTimerSchedule } from "./unref-timer";

export type DaemonRuntimeLifecycle = {
  requestRestart?(requestId: string): Promise<void>;
  requestUpgrade?(
    requestId: string,
    expectedVersion?: string,
    releaseChannel?: string,
  ): Promise<void>;
  recoveredRestartRequestIds?: string[];
  recoveredUpgradeRequestIds?: string[];
  /** Upgrade results still owed to the server. */
  recoveredUpgradeResults?: RecoveredUpgradeResult[];
  /**
   * Re-reads durable upgrade operations while one is pending.
   */
  readUpgradeOperations?(): Promise<UpgradeOperationsReading>;
  /** Reporter retry timer. */
  upgradeResultSchedule?: UnrefTimerSchedule;
  /** Called once the server has accepted a reported result. */
  acknowledgeUpgradeResult?(requestId: string): Promise<void>;
  /** Called when the cloud permanently refuses this Workspace. */
  connectionRefused?(reason: DaemonConnectRejectionReason): void;
  /** Whether an installer upgrade is in flight. */
  installerJournalExists?(): boolean;
};
