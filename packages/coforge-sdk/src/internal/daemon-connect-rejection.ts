/**
 * Why the cloud refused a Daemon's Workspace connection for good. Restarting or reconnecting
 * cannot change either answer; only attaching the Computer again (setup) can.
 */
export const DAEMON_CONNECT_REJECTION_REASONS = [
  "workspace_deleted",
  "computer_unlinked",
  "credential_revoked",
] as const;
export type DaemonConnectRejectionReason = (typeof DAEMON_CONNECT_REJECTION_REASONS)[number];

/**
 * The Centrifugo custom disconnect code for each refusal. Centrifugo reserves 4500-4999 for
 * terminal custom disconnects, which its client SDKs do not reconnect after.
 */
export const DAEMON_CONNECT_REJECTION_CODES = {
  workspace_deleted: 4501,
  computer_unlinked: 4502,
  credential_revoked: 4503,
} as const satisfies Record<DaemonConnectRejectionReason, number>;

/**
 * The Centrifugo custom disconnect the server sends a Daemon's live connection when it should
 * connect again right away, so that the connect proxy answers it afresh: a Workspace just deleted
 * then refuses it with `workspace_deleted`. It is in 4000-4499, which Centrifugo's client SDKs
 * reconnect after.
 */
export const DAEMON_RECONNECT_DISCONNECT = { code: 4001, reason: "reconnect" } as const;

/**
 * The Centrifugo custom disconnect the connect proxy answers a second live connection for one
 * Workspace binding with. It is not a refusal for good: 4000-4499 makes the client reconnect,
 * so the duplicate waits its turn and connects once the binding's first connection is gone.
 */
export const DAEMON_DUPLICATE_CONNECTION_DISCONNECT = {
  code: 4003,
  reason: "duplicate_connection",
} as const;

export function isDaemonConnectRejectionReason(
  value: unknown,
): value is DaemonConnectRejectionReason {
  return DAEMON_CONNECT_REJECTION_REASONS.some((reason) => reason === value);
}

/** The refusal a Centrifugo disconnect carries, when its code and reason both name one. */
export function daemonConnectRejectionReason(disconnect: {
  code?: number;
  reason?: string;
}): DaemonConnectRejectionReason | undefined {
  const { reason } = disconnect;
  return isDaemonConnectRejectionReason(reason) &&
    DAEMON_CONNECT_REJECTION_CODES[reason] === disconnect.code
    ? reason
    : undefined;
}
