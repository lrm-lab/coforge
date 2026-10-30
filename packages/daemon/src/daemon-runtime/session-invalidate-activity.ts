import {
  RUNTIME_PROVIDER,
  WORKSPACE_PROTOCOL_MAJOR,
  type AgentSessionInvalidate,
  type AgentSessionInvalidateReason,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";

/** Human runtime label for an invalidated-session Activity notice. */
const RUNTIME_DISPLAY_NAME: Record<RuntimeProvider, string> = {
  [RUNTIME_PROVIDER.CODEX]: "Codex",
  [RUNTIME_PROVIDER.CLAUDE_CODE]: "Claude Code",
  [RUNTIME_PROVIDER.KIRO]: "Kiro",
  [RUNTIME_PROVIDER.CURSOR]: "Cursor CLI",
  [RUNTIME_PROVIDER.OPENCODE]: "OpenCode",
  [RUNTIME_PROVIDER.GROK]: "Grok Build",
  [RUNTIME_PROVIDER.ANTIGRAVITY]: "Antigravity CLI",
  [RUNTIME_PROVIDER.DSH]: "DeepSeek Harness",
  [RUNTIME_PROVIDER.COMMAND_CODE]: "Command Code",
  [RUNTIME_PROVIDER.DEVIN]: "Devin",
  [RUNTIME_PROVIDER.PI]: "Pi",
  [RUNTIME_PROVIDER.COFORGE]: "CoForge",
};

export function runtimeDisplayName(provider: RuntimeProvider): string {
  return RUNTIME_DISPLAY_NAME[provider];
}

/** The one wire shape both `invalidateSession` emit sites send, built from the report envelope and
 * the stale session it names. No control-fence fields (no `startRequestId`/`controlEpoch`, unlike
 * `AgentSessionReport`): `launchId` is always present at both call sites. */
export function sessionInvalidateMessage(
  envelope: Pick<
    AgentSessionInvalidate,
    "protocolMajor" | "requestId" | "workspaceId" | "computerId"
  >,
  daemonInstanceId: string,
  fields: Pick<
    AgentSessionInvalidate,
    "agentId" | "provider" | "sessionId" | "launchId" | "reason"
  >,
): AgentSessionInvalidate {
  return { ...envelope, ...fields, daemonInstanceId };
}

/** Narration for a daemon-initiated cold start after a session invalidate. */
export function sessionInvalidateActivityText(
  runtimeLabel: string,
  staleSessionId: string,
  reason: AgentSessionInvalidateReason,
): { detail: string; entryText: string } {
  const rejected = reason === "provider_replay_rejected";
  return {
    detail: `Stored ${runtimeLabel} session ${rejected ? "replay rejected" : "missing"}; cold-starting a new session…`,
    entryText: `Stored ${runtimeLabel} session ${staleSessionId} ${rejected ? "was rejected by the provider during replay" : "is unavailable locally"}. Falling back to a cold start; earlier runtime context may not be restored.`,
  };
}

/** The same message for a runtime's own connection and instance. */
export function connectionSessionInvalidate(
  connection: { workspaceId: string; computerId: string },
  daemonInstanceId: string,
  fields: Pick<
    AgentSessionInvalidate,
    "agentId" | "provider" | "sessionId" | "launchId" | "reason"
  >,
): AgentSessionInvalidate {
  return sessionInvalidateMessage(
    {
      protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
      requestId: crypto.randomUUID(),
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
    },
    daemonInstanceId,
    fields,
  );
}
