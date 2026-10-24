import type { AgentMessageRecord } from "./agent-messages.server";

/**
 * The freshness reads and read-through advance of one already-resolved Agent-facing target. The
 * Agent's own messages are never context to review, and every read that takes
 * `excludingSequences` (`seenExactSeqs`, the messages the Agent was shown one by one) leaves those
 * out as well: this port is the one place that rule is applied.
 */
export type AgentTargetFreshness = {
  /** The newest (at most three) pending messages above `afterSequence`, oldest first. */
  readPending?(
    afterSequence?: number,
    excludingSequences?: readonly number[],
  ): Promise<readonly AgentMessageRecord[]>;
  /** Same pending-context scope as `readPending`, but a count rather than a 3-row window. */
  countPending?(afterSequence?: number, excludingSequences?: readonly number[]): Promise<number>;
  /** The newest pending message's sequence above `afterSequence`, as one aggregate; `undefined`
   * when nothing is pending. */
  maxPendingSequence?(afterSequence?: number): Promise<number | undefined>;
  /** The target's `limit` most recent messages, ignoring the Agent's own read boundary: the source
   * of the first-touch `syncing_hold` (`target_first_touch_recent_context`). `unseen` is that
   * window less `excludingSequences`, oldest first; `maxSequence` the window's newest. */
  readRecent?(
    limit: number,
    excludingSequences?: readonly number[],
  ): Promise<{ unseen: readonly AgentMessageRecord[]; maxSequence: number | undefined }>;
  /** The server's own read-through for the target: what reads, checks and reported boundaries
   * have consumed, as this send found it. */
  readThrough?(): Promise<number>;
  advanceReadThrough?(sequence: number): Promise<number>;
};
