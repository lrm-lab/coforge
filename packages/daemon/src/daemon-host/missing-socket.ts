import { dispose, getLogger } from "@logtape/logtape";
import { COFORGE_DAEMON_SERVER_URL } from "#src/connection/built-server";
import { DaemonConfigStore } from "#src/persistence/daemon-config";
import {
  workspaceDegradedMessage,
  type WorkspaceHealthJournal,
} from "#src/supervisor/workspace-health-journal";

/** `--socket` is required for every launch this build understands; a launch missing it is a
 * precondition no restart can fix. */
const MISSING_SOCKET_REASON = "Daemon requires --socket";

/** `runDaemon` without `--socket`: reports the launch as broken and returns with exit code 0.
 * `explicitStateDirectory` is whether `--state-directory` was passed. */
export async function refuseMissingSocket(
  daemonStateDirectory: string,
  explicitStateDirectory: boolean,
  healthJournal: WorkspaceHealthJournal,
): Promise<void> {
  // Terminal, not a crash to retry: restarting this exact invocation can never supply the
  // missing argument. Latching degraded and exiting 0 (see the degraded branch of `runDaemon` in index.ts for why
  // exit 0 is what stops both supervisors' restart loop) keeps a broken launch from spinning
  // forever instead of surfacing once with the fix. Only latch when `--state-directory` was
  // itself explicit: under every OS-supervised launch (the only shipped path) the Coordinator
  // always supplies both flags together, so a launch missing `--socket` but not
  // `--state-directory` never happens there. Without an explicit `--state-directory` this
  // falls back to the shared default `~/.coforge/daemon` - not a real per-Workspace directory
  // the Coordinator's `clearHealth` seam ever reaches - so writing a latch there could
  // permanently poison a later, unrelated standalone run with no way to clear it short of
  // deleting the file by hand. A hand-run invocation missing both flags gets today's plain
  // failure instead, exactly as before this change.
  if (explicitStateDirectory) await healthJournal.markTerminal(MISSING_SOCKET_REASON);
  const brokenConfig = explicitStateDirectory
    ? await new DaemonConfigStore(daemonStateDirectory, {
        serverHttpUrl: COFORGE_DAEMON_SERVER_URL,
      })
        .load()
        .catch(() => null)
    : null;
  getLogger(["coforge", "daemon"]).error(
    workspaceDegradedMessage(MISSING_SOCKET_REASON, brokenConfig?.workspaceId),
    { event: "daemon:invalid_arguments" },
  );
  await dispose();
  process.exitCode = 0;
}
