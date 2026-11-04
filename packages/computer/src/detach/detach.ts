import { DaemonCommandRejectedError, type DaemonCommandRunner } from "@lrm/coforge-daemon";

import type { ComputerConfig } from "#src/local-config";

/**
 * `coforge-computer detach` (task #417 step 3): the machine leaves a Workspace, server first —
 * the Daemon's `DETACH` command revokes the key and unlinks only once the server answers
 * definitely, and this machine's local registration goes only when that same definite answer
 * comes back. `detach_unconfirmed` — a timeout, a 5xx, a server that could not be asked —
 * keeps the registration exactly as it was and reports that the server never confirmed.
 */
export type DetachOutcome =
  | { kind: "detached"; workspaceSlug: string }
  | { kind: "unconfirmed"; workspaceSlug: string }
  /** The supervisor never bound this Workspace — its local half is gone already, but its key
   * may still be alive server-side, so the registration stays (task #417). */
  | { kind: "not_bound"; workspaceSlug: string }
  /** The server had already revoked this machine's key — the local registration is gone, but
   * a re-attach under a newer key may still be live, so it is not "detached" (task #417). */
  | { kind: "key_revoked"; workspaceSlug: string }
  | { kind: "not_attached" };

export async function detachWorkspace(
  deps: {
    daemon: Pick<DaemonCommandRunner, "command">;
    config?: Pick<ComputerConfig, "loadRegistration" | "discardRegistration"> &
      Partial<Pick<ComputerConfig, "loadCurrentProfile">>;
  },
  workspace?: string,
): Promise<DetachOutcome> {
  if (!deps.config?.loadRegistration || !deps.config.discardRegistration)
    return { kind: "not_attached" };
  const registration = await deps.config.loadRegistration(workspace);
  if (!registration) return { kind: "not_attached" };
  // The Computer's own id and server ride the request: a Workspace the supervisor has no
  // binding for can still be told to unlink its key (task #417).
  const profile = deps.config.loadCurrentProfile ? await deps.config.loadCurrentProfile() : null;
  const target =
    profile && registration.computerId
      ? { computerId: registration.computerId, serverHttpUrl: profile.serverUrl }
      : undefined;
  try {
    const result = await deps.daemon.command("detach", registration.id, target);
    const keyRevoked = (result as { detachKeyRevoked?: boolean }).detachKeyRevoked === true;
    // Only a definite server answer removes the local registration.
    await deps.config.discardRegistration(registration);
    if (keyRevoked) return { kind: "key_revoked", workspaceSlug: registration.slug };
    return { kind: "detached", workspaceSlug: registration.slug };
  } catch (error) {
    if (error instanceof DaemonCommandRejectedError) {
      if (error.code === "detach_unconfirmed")
        return { kind: "unconfirmed", workspaceSlug: registration.slug };
      if (error.code === "detach_not_bound")
        return { kind: "not_bound", workspaceSlug: registration.slug };
    }
    throw error;
  }
}
