/**
 * The daemon could not hand the Agent's session a wakeup notice because the session was going
 * away (its notice generation was cancelled mid-notice) or cannot receive one at all. Transient:
 * the tracker reports `IDENTITY_UNKNOWN`, so the server wakes the Agent and re-issues the mention
 * for the relaunched session instead of settling it lost.
 */
export class AgentWakeupUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AgentWakeupUnavailableError";
  }
}

/** One notice generation per session incarnation: cancelling it abandons in-flight notices. */
export type NoticeGeneration = {
  cancellation: AbortController;
  seenDeliveryIds: Set<string>;
  seenMessageIds: Set<string>;
  notified: Set<string>;
  /** Ids of deliveries whose attention `receive` recorded and that are held (or batched, for
   * Memory) until `flush` takes them. The remembered window forgets the oldest ids, so it cannot
   * say, past its size, whether a held delivery was recorded; a resend of one is not recorded
   * again, and `flush` does not record it a second time. */
  recordedHeld: Set<string>;
  notificationAttempts: Map<string, Promise<void>>;
};

export function noticeGeneration(): NoticeGeneration {
  return {
    cancellation: new AbortController(),
    seenDeliveryIds: new Set(),
    seenMessageIds: new Set(),
    notified: new Set(),
    recordedHeld: new Set(),
    notificationAttempts: new Map(),
  };
}

/**
 * Writes the notice, unless the generation is cancelled first. A cancelled notice means the
 * session incarnation ended under it, so it surfaces as a wakeup-unavailable failure rather than
 * a bare abort.
 */
export async function acceptNotice(signal: AbortSignal, send: () => Promise<void>): Promise<void> {
  signal.throwIfAborted();
  const cancelled = Promise.withResolvers<never>();
  const abort = () =>
    cancelled.reject(
      new AgentWakeupUnavailableError("the Agent's notice was cancelled", { cause: signal.reason }),
    );
  signal.addEventListener("abort", abort, { once: true });
  try {
    await Promise.race([send(), cancelled.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
