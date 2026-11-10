import type {
  AgentControlResult,
  AgentSessionInvalidateReason,
  AgentStartIntent,
  SessionIdentity,
} from "@lrm/coforge-sdk/internal";
import type { AgentRuntimeState } from "./agent-runtime-state";
import type { AgentSessions } from "./agent-session";

/** The Agent runtime operations `AgentControl` drives. */
export type AgentControlRuntime = {
  running(agentId: string): boolean;
  stop(agentId: string): Promise<SessionIdentity | undefined>;
  /** A Stop passed every check and is about to run: what only a person's Stop ends, ends here. */
  stopAccepted?(agentId: string): void;
  launch(
    intent: AgentStartIntent,
    launchId: string,
    replacedSessionId?: string,
    /** Set only alongside `replacedSessionId`, for the same `invalidateSession` call that
     * preceded this retry launch; narrates the fresh launch's cold-start Activity with the
     * reason that was actually reported, without a daemon-side side-channel map (fix for the
     * removed `#pendingSessionInvalidateReason`). */
    invalidateReason?: AgentSessionInvalidateReason,
  ): Promise<SessionIdentity | undefined>;
  wake?(intent: AgentStartIntent): Promise<void>;
  /** Fire-and-forget; never blocks or fails the launch it is reported alongside. */
  invalidateSession?(
    intent: AgentStartIntent,
    launchId: string,
    sessionId: string,
    reason: AgentSessionInvalidateReason,
  ): void;
  /**
   * Rebinds an already-running process to a newer control scope without spawning a second one:
   * a Start that finds `running(agentId)` true under an older, TERMINAL operation adopts the
   * new request instead of being rejected. `launchId` is the identity the running process
   * adopts for every later daemon->server message about it (today always `intent.launchId`, the
   * server-supplied id for this new operation) — re-points every place that remembers the
   * previous launch's identity (session reference, activity launch/clientSeq, status, pending
   * Activity/invalidate bookkeeping) and sends the immediate Session re-report and
   * `agent:status(active)` under the new scope. Returns the running process's current Session
   * identity, exactly like `launch` does for a fresh start, so the caller can report it in the
   * rebind's `started` result. Never requests a new launch config/credential — the running
   * process's existing Agent API key and local proxy token are kept.
   */
  rebind(intent: AgentStartIntent, launchId: string): Promise<SessionIdentity | undefined>;
  result(result: AgentControlResult): Promise<void>;
  /** A Start that was pending for this Agent (see `startPending`) no longer is: it launched, its
   * attempts ran out, or a Stop or newer operation ended it. */
  startSettled?(agentId: string): void;
};

/** What every part of Agent control reads: the daemon instance, the shared state, Sessions and the runtime port. */
export type AgentControlContext = {
  readonly instanceId: string;
  readonly state: AgentRuntimeState;
  readonly sessions: AgentSessions;
  readonly runtime: AgentControlRuntime;
};
