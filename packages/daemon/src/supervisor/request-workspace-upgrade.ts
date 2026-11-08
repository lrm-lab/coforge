import type { DaemonConfig } from "#src/daemon-runtime/runtime";
import type { LocalDaemonLauncher } from "#src/daemon-host/launcher";

type SupervisorControl = (
  ...request: Parameters<LocalDaemonLauncher["control"]>
) => ReturnType<LocalDaemonLauncher["control"]>;

export async function requestWorkspaceUpgrade(
  config: DaemonConfig | null,
  supervisorControl: SupervisorControl,
  requestId: string,
  expectedVersion: string | undefined,
  releaseChannel: string | undefined,
): Promise<void> {
  if (!config) throw new Error("Workspace is not configured");
  if (!expectedVersion) throw new Error("upgrade expected version is unavailable");
  await supervisorControl(
    "upgrade",
    config.workspaceId,
    requestId,
    expectedVersion,
    releaseChannel,
  );
}
