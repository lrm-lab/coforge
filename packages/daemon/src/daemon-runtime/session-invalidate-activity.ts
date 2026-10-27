import {
  RUNTIME_PROVIDER,
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
  [RUNTIME_PROVIDER.PI]: "Pi",
  [RUNTIME_PROVIDER.COFORGE]: "CoForge",
};

export function runtimeDisplayName(provider: RuntimeProvider): string {
  return RUNTIME_DISPLAY_NAME[provider];
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
