import { WORKSPACE_RELAUNCH_SECONDS } from "./workspace-instance";

/**
 * How often a Windows Coordinator checks that each enabled Workspace child is still alive.
 * Linux/macOS rely on systemd/launchd `Restart`/`KeepAlive`; Windows has no OS unit, so the
 * Coordinator is the failure-restart agent, polling at the shared relaunch bound.
 */
export const WINDOWS_WORKSPACE_RECONCILE_MS = WORKSPACE_RELAUNCH_SECONDS * 1_000;

export type WorkspaceReconcileLoop = {
  stop: () => void;
};

export async function startWorkspaceReconcileLoop(
  reconcile: (workspaceIds?: readonly string[]) => Promise<void>,
  options: {
    platform?: NodeJS.Platform;
    pendingUpgradeWorkspaces?: () => Promise<readonly string[]>;
    intervalMs?: number;
    setIntervalFn?: typeof setInterval;
    clearIntervalFn?: typeof clearInterval;
    onError?: (error: unknown) => void;
  } = {},
): Promise<WorkspaceReconcileLoop | null> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" && !(await options.pendingUpgradeWorkspaces?.())?.length) return null;
  const intervalMs = options.intervalMs ?? WINDOWS_WORKSPACE_RECONCILE_MS;
  const schedule = options.setIntervalFn ?? setInterval;
  const clear = options.clearIntervalFn ?? clearInterval;
  const onError = options.onError ?? (() => {});
  let inFlight = false;
  let stopped = false;
  const timer = schedule(() => {
    if (inFlight || stopped) return;
    inFlight = true;
    void tick()
      .catch(onError)
      .finally(() => {
        inFlight = false;
      });
  }, intervalMs);
  function stop() {
    stopped = true;
    clear(timer);
  }
  async function tick() {
    const workspaceIds =
      platform === "win32" ? undefined : await options.pendingUpgradeWorkspaces?.();
    if (stopped) return;
    if (workspaceIds?.length === 0) {
      stop();
      return;
    }
    await reconcile(workspaceIds);
  }
  return { stop };
}
