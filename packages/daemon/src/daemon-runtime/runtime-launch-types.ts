import type { AgentSessionInvalidateReason } from "@lrm/coforge-sdk/internal";

export type SessionMode = "create" | "resume";

/** Cloud-supplied identity for one launch; every field falls back to the previous reference. */
export type LaunchRequest = {
  sessionId?: string;
  /** The launch's first turn, in place of message recovery (see `AgentStartIntent`). */
  resumePrompt?: string;
  /** Server-written text for an Agent that has not introduced itself to its creator; it opens
   * the launch ahead of recovery and `resumePrompt` (see `AgentStartIntent`). */
  introductionPrompt?: string;
  requestId?: string;
  previousLaunchId?: string;
  sessionMode?: SessionMode;
  control?: { controlEpoch?: number; launchId: string };
  replacedSessionId?: string;
  /** Set only alongside `replacedSessionId`, threaded from `AgentControl.start()`'s retry
   * launch through `Runtime.launch(...)`; narrates the retry's cold-start Activity with the
   * reason that was actually reported. Replaces the old `#pendingSessionInvalidateReason`
   * side-channel map: a reason can no longer outlive its launch or attach to an unrelated one,
   * and is never set without being consumed. */
  invalidateReason?: AgentSessionInvalidateReason;
};

export type AgentProxy = {
  url: string;
  issue(agentId: string, agentApiKey: string): string;
  revoke(token: string): void;
};
