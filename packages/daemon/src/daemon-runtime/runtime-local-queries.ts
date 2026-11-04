import type { AgentVersionResponse } from "@lrm/coforge-sdk/agent";
import { COFORGE_DAEMON_VERSION } from "../version";

import type { ComputerUpdateNotice } from "./computer-update-notice";

/**
 * `coforge version`'s local-only answer, assembled entirely from this already-running
 * Workspace child, never forwarded to Web/backend. `computerVersion` is the Computer executable
 * version this Daemon was launched with (`runDaemon(args, computerVersion)`, `packages/computer/
 * src/main.ts`'s `__workspace-daemon` dispatch); it bundles both the Computer and Daemon package
 * roles into one executable, so this is not a second installation.
 */
export function localVersionResponse(own: {
  computerVersion?: string;
  startedAt: number;
}): AgentVersionResponse {
  return {
    ok: true,
    daemonVersion: COFORGE_DAEMON_VERSION,
    ...(own.computerVersion ? { computerVersion: own.computerVersion } : {}),
    daemonPid: process.pid,
    startedAt: own.startedAt,
  };
}

/** The one-line "a newer Computer release exists" notice a CLI appends to its output — local
 * only, once per calendar day per computer; null when nothing is newer or already told. */
export async function localComputerUpdateNotice(
  notice: ComputerUpdateNotice,
): Promise<{ ok: true; notice: string | null }> {
  // A failed read/write answers "no notice", never an error: the line is best effort.
  return { ok: true, notice: await notice.takeNotice().catch(() => null) };
}
