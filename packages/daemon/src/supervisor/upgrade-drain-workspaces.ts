import { getLogger } from "@logtape/logtape";
import type { DaemonHoldResponse, RunnerHoldReason } from "@lrm/coforge-sdk/internal";
import { snapshotUpgradeBindings } from "#src/platform/computer-upgrade-progress";
import { answeredWithin } from "./runner-hold";
import { UpgradeDrainWatcher } from "./upgrade-drain-watcher";
import type { UpgradeWorkspaceInstance } from "./workspace-instance";

const NATIVE_PROBE_TIMEOUT_MS = 750;
export const UPGRADE_HOLD_TIMEOUT_MS = 2_000;

const logger = getLogger(["coforge", "daemon", "supervisor"]);

type Binding = { workspaceId: string; enabled: boolean; inFlight: boolean; startRevision: number };
type Observation = Binding & { instance: UpgradeWorkspaceInstance };

export function supervisorUpgradeDrainWatcher(options: {
  stateDirectory: string;
  installRoot: string;
  bindings(): readonly Binding[];
  observe(workspaceId: string, timeoutMs: number): Promise<UpgradeWorkspaceInstance>;
  hold(
    workspaceId: string,
    reason: RunnerHoldReason,
    processId: number,
    timeoutMs: number,
  ): Promise<DaemonHoldResponse>;
  release(workspaceIds: readonly string[]): Promise<unknown>;
  now?: () => number;
}) {
  const heldWorkspaces = new Set<string>();
  let lastLogged: string | undefined;

  async function observe(previous: readonly Binding[] = []): Promise<Observation[]> {
    const bindings = new Map(options.bindings().map((binding) => [binding.workspaceId, binding]));
    for (const { workspaceId, startRevision } of previous) {
      if (!bindings.has(workspaceId))
        bindings.set(workspaceId, { workspaceId, enabled: false, inFlight: false, startRevision });
    }
    return Promise.all(
      [...bindings.values()].map(async (binding) => ({
        ...binding,
        instance: await answeredWithin(
          options.observe(binding.workspaceId, NATIVE_PROBE_TIMEOUT_MS),
          NATIVE_PROBE_TIMEOUT_MS,
          "Workspace instance observation timed out",
        ).catch(() => "pending" as const),
      })),
    );
  }

  async function holdWorkspace(
    { workspaceId, instance, inFlight }: Observation,
    reason: RunnerHoldReason,
  ) {
    if (inFlight || !instance || instance === "pending" || !instance.active) return null;
    heldWorkspaces.add(workspaceId);
    const response = await answeredWithin(
      options.hold(workspaceId, reason, instance.mainPid, UPGRADE_HOLD_TIMEOUT_MS),
      UPGRADE_HOLD_TIMEOUT_MS,
      "Workspace upgrade runner hold timed out",
    ).catch(() => null);
    if (!response?.accepted || !response.held || response.unreachableWorkspaceIds.length)
      return null;
    return { instance, busyCount: response.busyAgents.length };
  }

  return new UpgradeDrainWatcher({
    stateDirectory: options.stateDirectory,
    now: options.now,
    hold: async (reason, drainId, publishPending) => {
      await publishPending();
      const before = await observe();
      await answeredWithin(
        snapshotUpgradeBindings(options.installRoot, drainId, async () =>
          before.map(({ workspaceId, enabled, inFlight, instance }) => ({
            workspaceId,
            enabled,
            lifecycleUnderWay: inFlight || instance === "pending",
            processId: instance && instance !== "pending" && instance.active ? instance.mainPid : 0,
          })),
        ),
        NATIVE_PROBE_TIMEOUT_MS,
        "Upgrade binding snapshot timed out",
      ).catch(() => {});
      const held = await Promise.all(before.map((workspace) => holdWorkspace(workspace, reason)));
      const receipts = new Map(before.map(({ workspaceId }, index) => [workspaceId, held[index]]));

      let busyCount = 0;
      const pending = [];
      const after = await observe(before);
      const latest = new Map(options.bindings().map((binding) => [binding.workspaceId, binding]));
      for (const { workspaceId, instance, enabled, inFlight, startRevision } of after) {
        const binding = latest.get(workspaceId);
        latest.delete(workspaceId);
        const changing =
          inFlight ||
          (binding &&
            (binding.inFlight ||
              binding.startRevision !== startRevision ||
              (binding.enabled && !enabled)));
        if (!changing && instance === null) continue;
        const receipt = receipts.get(workspaceId);
        if (
          !changing &&
          instance &&
          instance !== "pending" &&
          instance.active &&
          receipt?.instance.mainPid === instance.mainPid &&
          receipt.instance.invocationId === instance.invocationId
        ) {
          busyCount += receipt.busyCount;
        } else {
          pending.push({
            workspace_id: workspaceId,
            ...(instance && instance !== "pending"
              ? { process_id: instance.mainPid, invocation_id: instance.invocationId }
              : {}),
          });
        }
      }
      for (const workspaceId of latest.keys()) pending.push({ workspace_id: workspaceId });
      const published = { drain_id: drainId, busy_count: busyCount, pending_workspaces: pending };
      const fingerprint = JSON.stringify(published);
      if (fingerprint !== lastLogged) {
        lastLogged = fingerprint;
        logger.info("Observed upgrade drain workspaces", {
          event: "upgrade:drain_workspaces",
          ...published,
        });
      }
      return { busyCount: Math.max(busyCount, pending.length ? 1 : 0) };
    },
    release: async () => {
      const workspaces = [...heldWorkspaces];
      heldWorkspaces.clear();
      lastLogged = undefined;
      await options.release(workspaces);
    },
  });
}
