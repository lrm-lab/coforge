import type { AgentConversationScope, AgentRuntimeEvent, AgentSessionIdentity } from "./contract";

/** What the daemon says about a notice beyond its text. `deliveryIds` names the tracked
 * deliveries the notice carries; a provider only echoes them on `notice-undelivered`. */
export type AgentNoticeOptions = {
  deliveryIds?: readonly string[];
  conversation?: AgentConversationScope;
};
export interface AgentSession {
  readonly contextViewRequestLogPath?: string;
  /** Associates the next provider request with the daemon's triggering message. */
  setContextViewMessageId?(messageId: string | undefined): void;
  /** Associates the next provider request with every delivery in a coalesced notice. */
  setContextViewMessageIds?(messageIds: readonly string[]): void;
  /** Resolves once the provider has captured the request associated with the notice. */
  waitForContextViewCapture?(): Promise<void>;
  /** Provider-observed work, including pending admission and interruption.
   * Undefined means the adapter cannot determine it; never infer idle from silence. */
  readonly hasLiveTurn?: boolean;
  /** Whether input sent while a turn is in progress reaches the model inside that turn — the
   * session's steer path — rather than queueing behind it for the next turn. Each adapter
   * declares it where its session is built (an ACP session from its profile's `steer`); an
   * adapter without a steer path omits it, which the daemon reads as queue-only. The daemon's
   * stalled recovery picks its silence fuse from this, never from the provider's name. */
  readonly steersBusyTurn?: boolean;
  /** Whether a subagent that outlives its turn needs the daemon to write a wake notice once the
   * last one finishes (Raft's `needsWakeAfterSubagents`). Codex runs delegated work on secondary
   * threads the main turn never resumes on its own; an adapter whose own task notifications
   * already reach a quiet session omits it, which the daemon reads as no wake needed. */
  readonly wakesAfterSubagents?: boolean;
  sendMessage(message: string): Promise<void>;
  hasLiveTurnForConversation?(conversationId: string): boolean | undefined;
  cancelPendingNotices?(): void;
  purgeConversation?(conversationId: string): Promise<void>;
  readSessionIdentity?(): Promise<AgentSessionIdentity | undefined>;
  /**
   * Accept a notification in this session, including while work is in progress.
   * Resolve at the adapter's delivery boundary, not after the whole run.
   * Claude uses boundary-gated stdin write success; SDK/RPC adapters wait for
   * native acceptance. Neither guarantees model processing or a reply.
   * Reject failed delivery without ending an otherwise active run.
   * Adapters own native steering/queued-input protocols; callers own retry/ACK.
   */
  notify?(notice: string, options?: AgentNoticeOptions): Promise<void>;
  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void;
  interrupt(): Promise<void>;
  /**
   * Interrupt one provider task by its `subagent-progress` `taskId`, leaving the main session
   * running — the per-subagent counterpart of `interrupt()`. Resolves `"interrupted"` once the
   * stop request was accepted, `"not_running"` when the task is unknown or already finished.
   * Adapters without a per-task stop omit the method; the daemon reports that as unsupported.
   */
  interruptSubagent?(taskId: string): Promise<"interrupted" | "not_running">;
  /**
   * Kill only the descendant processes a turn started, after its native interrupt resolved —
   * Raft's `killTurnProcesses`. The window is on the host process table's clock
   * (`processClockMs`): `startedAfterMs` is the turn's cutoff (never converted from wall time),
   * `startedBeforeMs` bounds the turn's end when the caller knows it. Adapters whose process
   * tree cannot name turn descendants omit the method.
   */
  killTurnProcesses?(window: AgentTurnProcessWindow): Promise<void>;
  /**
   * Fires once when the provider runtime ends. `exit` carries how the underlying process
   * ended when the adapter can observe it: `code` on a self-exit, `signal` on a signal
   * death, and neither when the adapter cannot tell (embedded runtimes, expected stops).
   * Adapters that never observe exits may call the listener with no argument.
   */
  onExit(listener: (exit?: AgentSessionExit) => void): () => void;
  /** Terminal stop: reject undelivered input and begin runtime cleanup without waiting for a
   * natural turn end. Resolve only after cleanup; reject if process exit cannot be confirmed. */
  dispose(options?: Readonly<{ cutoffAtMs?: number }>): Promise<void>;
}

/** The host process-table window a turn-scoped descendant kill may take (`killTurnProcesses`). */
export type AgentTurnProcessWindow = {
  startedAfterMs: number;
  startedBeforeMs?: number;
};

/** How a provider process ended, mirroring a Node-style `exit` event: exactly one of
 * `code` or `signal` is set on a real process end; both absent means the adapter cannot
 * tell (expected stop, embedded runtime, relay without signal detail). */
export type AgentSessionExit = Readonly<{
  code?: number | null;
  signal?: string | null;
  /** The session ended, but the process tree could not be confirmed gone, so something may still
   * be running under it. The end is real; the daemon sweeps the Agent's launch tag before its
   * next Start (task #704). */
  cleanupUnconfirmed?: boolean;
}>;
