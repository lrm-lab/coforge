import type { AgentSessionInvalidateReason } from "@lrm/coforge-sdk/internal";
import type { AgentRecoveryContext } from "./runtime-launch-intent";

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
  /** Set when the launch comes from a server Start's own fields rather than the restart config;
   * carries that Start's `agentConfigRevision`. */
  fromStart?: { agentConfigRevision?: number };
  /** The recovery this launch opens with: a server Start's own, or what a launch the daemon starts
   * itself must still tell the Agent (the Start's takes precedence). A cold start of a rejected
   * launch carries it on (`provider-replay-recovery.ts`). */
  recovery?: AgentRecoveryContext;
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
