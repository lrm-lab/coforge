// `coforge-computer stop`: the whole Computer down, through the manager that runs it.

import { thrownMessage } from "@lrm/coforge-sdk/internal";
import { DAEMON_STOP_WAIT_MS } from "@lrm/coforge-daemon";
import { CliError } from "#src/errors";

/** Platform and local control seams used by `stopComputer`. `assertRestartable` is the hosts'
 * "the platform manager really runs this Computer" gate; `stop` takes the Coordinator down
 * through that manager. */
export type StopComputerHost = {
  /** Rejects unless the platform manager runs this Computer's Coordinator service. */
  assertRestartable(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): Promise<boolean>;
  /** Tells a running Coordinator to stop its Workspace runtimes, which also records each binding
   * as stopped so `status` reads it that way until the next `start`. Best effort: the manager's
   * own stop takes those runtimes down whether or not this answers. */
  stopRuntimes?(): Promise<unknown>;
};

export type StopComputerOptions = {
  /** Write one stable JSON result instead of the prose a person reads. */
  json?: boolean;
  /** How long to wait for the Coordinator to stop answering, and the seams that wait runs on.
   * Defaults to the Daemon's own stop budget (`DAEMON_STOP_WAIT_MS`) rather than a number of its
   * own: waiting less reported a stop that was still finishing as one that failed (task #726). */
  waitMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

const STOP_POLL_MS = 100;

/**
 * Stops this Computer: the Coordinator process and every Workspace runtime under it, through the
 * platform manager, so nothing brings it back until `coforge-computer start`.
 *
 * A Computer the manager does not run (a `foreground` process, a container, someone's own
 * supervisor) cannot be stopped from here: saying so is the whole answer — exiting 0 with the
 * process still answering would read as a stop that happened (task #696, from the #417
 * acceptance). A stop the manager reported but the Coordinator did not honor is reported too.
 */
export async function stopComputer(
  host: StopComputerHost,
  io: { stdout: (line: string) => void },
  options: StopComputerOptions = {},
): Promise<void> {
  const write = (line: string) => io.stdout(line);
  const refusal = await managedByServiceManager(host);
  if (refusal !== null) {
    // Not a service this manager runs. Nothing to do only when nothing answers either; a
    // `foreground` process is up and only its own supervisor can stop it.
    if (!(await host.isRunning())) {
      write(
        options.json
          ? JSON.stringify({ ok: true, stopped: false })
          : "The CoForge Computer is not running; nothing to stop.",
      );
      return;
    }
    throw new CliError(
      "STOP_OUTSIDE_SERVICE_MANAGER",
      `This Computer's CoForge Daemon is not run by the platform service manager: ${thrownMessage(refusal)}`,
      "Stop the CoForge Computer through the supervisor that started it (or the terminal running `coforge-computer foreground`), then run `coforge-computer status` to confirm.",
      { cause: refusal },
    );
  }
  // A running Coordinator records each binding stopped before it goes; the service stop below
  // takes the runtimes down even if this does not answer.
  if (await host.isRunning()) await host.stopRuntimes?.().catch(() => undefined);
  await host.stop();
  await confirmStopped(host, options);
  write(
    options.json
      ? JSON.stringify({ ok: true, stopped: true })
      : "CoForge Computer stopped; its Workspaces and Agents came down with it. Run `coforge-computer start` to bring it back.",
  );
}

/** The reason the platform manager does not run this Computer's service, or null when it does. */
async function managedByServiceManager(host: StopComputerHost): Promise<unknown | null> {
  try {
    await host.assertRestartable();
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(thrownMessage(error));
  }
}

/** Waits for the Coordinator to stop answering the local handshake. `stop()` returning only
 * means the manager accepted the request, so the process itself is what proves the stop. */
async function confirmStopped(host: StopComputerHost, options: StopComputerOptions): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? Bun.sleep;
  const deadline = now() + (options.waitMs ?? DAEMON_STOP_WAIT_MS);
  while (await host.isRunning()) {
    if (now() >= deadline) {
      throw new CliError(
        "STOP_NOT_CONFIRMED",
        "The platform service manager stopped the CoForge Daemon but it is still answering on this Computer's local socket.",
        "Run `coforge-computer status` to see what is still running; if it does not go away, end the `coforge-computer __daemon` process and start it again.",
      );
    }
    await sleep(STOP_POLL_MS);
  }
}
