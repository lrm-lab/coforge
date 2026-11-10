import { AGENT_ACTIVITY_DETAIL_KIND, type DaemonShutdownReason } from "@lrm/coforge-sdk/internal";

import type { TrustedAgentActivity } from "#src/server/db/repositories/agent-activity.repositories.server";
import type { ComputerLifecycleMemory } from "#src/server/computers/computer-lifecycle-memory.server";
import { writeSelfLaunchActivities, type SelfLaunchRow } from "./self-launch-activity.server";
import type { AgentVisibility } from "#src/features/agents/agent-visibility";

type Scope = { workspaceId: string; computerId: string };

/** The part of a settled upgrade or restart record this module reads. */
type OperationRecord = { status: string; workerInstanceId?: string };

export type ComputerLifecycleActivityPorts = {
  /** The active Agents assigned to the Computer. */
  agents(scope: Scope): Promise<{ id: string; visibility: AgentVisibility }[]>;
  record(activities: TrustedAgentActivity[]): Promise<void>;
  publish(channel: string, data: Uint8Array): Promise<void>;
  memory: ComputerLifecycleMemory;
  upgradeStatus(scope: Scope, requestId: string): Promise<OperationRecord | undefined>;
  restartStatus(scope: Scope, requestId: string): Promise<OperationRecord | undefined>;
  now?: () => number;
};

/** What a daemon's ready says about the process that just came up. */
export type ComputerReturn = {
  requestId: string;
  workerInstanceId: string;
  computerVersion?: string;
  recoveredUpgradeRequestIds: readonly string[];
  recoveredRestartRequestIds: readonly string[];
};

type Row = SelfLaunchRow;

/**
 * Computer lifecycle in Agent Activity: one row in the Activity of every active Agent on the
 * Computer when a Workspace daemon announces a deliberate shutdown, and one when a new daemon
 * instance is ready. What the second row says comes from what happened, not from what was
 * announced: the server's own upgrade and restart records, and the Computer version the previous
 * instance ran. Rows are best-effort observations like any other Activity.
 */
export class ComputerLifecycleActivity {
  constructor(private readonly ports: ComputerLifecycleActivityPorts) {}

  async shutdown(scope: Scope, notice: { requestId: string; reason: DaemonShutdownReason }) {
    await this.ports.memory.rememberShutdown(scope, notice.reason);
    await this.#write(scope, notice.requestId, {
      detailKind: AGENT_ACTIVITY_DETAIL_KIND.COMPUTER_DISCONNECTED,
      detail: "",
      level: "info",
    });
  }

  async ready(scope: Scope, back: ComputerReturn) {
    const claim = await this.ports.memory.claimReturn(scope, {
      workerInstanceId: back.workerInstanceId,
      ...(back.computerVersion ? { computerVersion: back.computerVersion } : {}),
    });
    if (!claim.first) return;
    const announced = await this.ports.memory.takeShutdown(scope);
    await this.#write(
      scope,
      back.requestId,
      await this.#returnRow(scope, back, announced, claim.previousComputerVersion),
    );
  }

  async #returnRow(
    scope: Scope,
    back: ComputerReturn,
    announced: DaemonShutdownReason | undefined,
    previousVersion: string | undefined,
  ): Promise<Row> {
    const version = back.computerVersion;
    const upgrade = await this.#settled(
      scope,
      back,
      back.recoveredUpgradeRequestIds,
      this.ports.upgradeStatus,
    );
    const versionChanged = Boolean(previousVersion && version && previousVersion !== version);
    if (upgrade === "completed" || (upgrade === undefined && versionChanged))
      return {
        detailKind: AGENT_ACTIVITY_DETAIL_KIND.COMPUTER_UPGRADED,
        detail: "",
        level: "info",
      };
    if (upgrade === "failed" || announced === "computer_upgrade")
      return {
        detailKind: AGENT_ACTIVITY_DETAIL_KIND.COMPUTER_OPERATION_FAILED,
        detail: `The upgrade did not complete${version ? `; still running ${version}` : ""}. Run \`coforge-computer upgrade\` to try again.`,
        level: "error",
      };
    if (
      announced === "computer_restart" ||
      (await this.#settled(
        scope,
        back,
        back.recoveredRestartRequestIds,
        this.ports.restartStatus,
      )) === "completed"
    )
      return {
        detailKind: AGENT_ACTIVITY_DETAIL_KIND.COMPUTER_RESTARTED,
        detail: "",
        level: "info",
      };
    return { detailKind: AGENT_ACTIVITY_DETAIL_KIND.COMPUTER_STARTED, detail: "", level: "info" };
  }

  /** "completed" when one of the operations was completed by this very instance, "failed" when
   * one failed, otherwise undefined. */
  async #settled(
    scope: Scope,
    back: ComputerReturn,
    requestIds: readonly string[],
    status: (scope: Scope, requestId: string) => Promise<OperationRecord | undefined>,
  ) {
    const records = await Promise.all(requestIds.map((requestId) => status(scope, requestId)));
    if (
      records.some(
        (record) =>
          record?.status === "completed" && record.workerInstanceId === back.workerInstanceId,
      )
    )
      return "completed" as const;
    if (records.some((record) => record?.status === "failed")) return "failed" as const;
    return undefined;
  }

  async #write(scope: Scope, requestId: string, row: Row) {
    await writeSelfLaunchActivities(this.ports, scope, {
      event: "computer_lifecycle_activity.publish_failed",
      requestId,
      launchId: `computer-lifecycle:${requestId}`,
      agents: await this.ports.agents(scope),
      row,
      observedAtMs: (this.ports.now ?? Date.now)(),
    });
  }
}
