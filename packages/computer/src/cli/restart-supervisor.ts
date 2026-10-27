// Restarts the Computer supervisor through the platform host and local control socket.

import { RUNNER_HOLD_REASONS, type HeldBusyAgent, thrownMessage } from "@lrm/coforge-sdk/internal";
import { holdRunnersUntilQuiescent, LocalDaemonLauncher } from "@lrm/coforge-daemon";
import { createDaemonLauncher, daemonExecutablePathFor } from "#src/daemon-service/daemon-host";
import { resolveDaemonSocketPath } from "#src/paths";

/** Platform and local control seams used by `restartSupervisor`. */
export type RestartSupervisorHost = {
  /** Rejects unless the platform manager already runs this Computer's Coordinator service. */
  assertRestartable(): Promise<void>;
  restart(): Promise<void>;
};
export type RestartSupervisorLocal = {
  identity(): Promise<unknown>;
  hold(
    operation: "hold" | "release",
    reason?: string,
  ): Promise<{ accepted: boolean; busyAgents: readonly HeldBusyAgent[] }>;
};

/** Restarts the Coordinator process through the platform host. */
export async function restartSupervisor(
  host: RestartSupervisorHost,
  local: RestartSupervisorLocal,
  io: { stdout: (line: string) => void },
): Promise<void> {
  const foregroundRefusal = (cause: unknown): Error =>
    new Error(
      `Cannot restart the supervisor of a foreground externally supervised Computer while it is running: ${thrownMessage(cause)} Restart it through its external supervisor, or install the supported user service with \`coforge-computer start\`.`,
      { cause },
    );
  // Refuse outright rather than let `restart()`'s recovery branch register a second Coordinator
  // for a Computer whose platform manager never installed one.
  try {
    await host.assertRestartable();
  } catch (error) {
    throw foregroundRefusal(error);
  }
  let held = false;
  try {
    await local.identity();
    held = true;
  } catch {
    io.stdout("Computer supervisor is unreachable; restarting without a runner hold.");
  }
  try {
    if (held) {
      io.stdout("Holding Agent runners until idle...");
      const outcome = await holdRunnersUntilQuiescent({
        hold: async () => {
          const response = await local.hold("hold", RUNNER_HOLD_REASONS.COMPUTER_RESTART);
          if (!response.accepted) throw new Error("Coordinator did not accept the runner hold");
          return { busyAgents: response.busyAgents, unreachableWorkspaceIds: [] };
        },
      });
      io.stdout(
        outcome.quiescent
          ? "Every Agent runner reported idle."
          : `Runner hold expired after ${outcome.elapsedMs}ms with ${outcome.busyAgents.length} Agent(s) still busy; restarting anyway.`,
      );
    }
    io.stdout("Restarting the Computer supervisor...");
    // The platform host already knows why its own restart failed and says so; rewriting that
    // into a fixed sentence about foreground supervision is how a `systemctl --user` refusal
    // came to read as a problem it was not. Only `assertRestartable` above can establish that.
    await host.restart();
    io.stdout("Computer supervisor restarted and answered its local handshake.");
  } finally {
    if (held) await local.hold("release", RUNNER_HOLD_REASONS.COMPUTER_RESTART).catch(() => {});
  }
}

export function createRestartSupervisorHost(
  platform: "darwin" | "linux" | "win32",
  installDirectory: string,
  stateDirectory: string,
  serverUrl: string,
): { host: RestartSupervisorHost; local: RestartSupervisorLocal } {
  return {
    host: createDaemonLauncher(platform, installDirectory, stateDirectory, serverUrl),
    local: new LocalDaemonLauncher({
      executablePath: daemonExecutablePathFor(platform, installDirectory),
      socketPath: resolveDaemonSocketPath({ platform, stateDirectory }),
      stateDirectory,
      serverUrl,
    }),
  };
}

/** Prints one line per Workspace binding an unscoped `restart` left alone because it was
 * disabled, so a caller does not mistake a silent skip for a completed restart. */
export function reportSkippedRestarts(
  io: { stdout: (line: string) => void },
  runtimes: readonly { workspaceId: string; enabled: boolean }[],
): void {
  for (const runtime of runtimes) {
    if (!runtime.enabled)
      io.stdout(
        `Workspace ${runtime.workspaceId} is stopped and was not restarted; run 'coforge-computer start' to bring it online.`,
      );
  }
}
