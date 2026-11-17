import { useEffect, useState } from "react";
import { Check, Copy01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { RelativeTime } from "#src/components/ui/relative-time";
import { StatusDot } from "#src/components/ui/status-dot";
import { m } from "#src/paraglide/messages";

export type ExternalSetupState = "waiting" | "online" | "offline" | "disconnected";

export type ExternalSetup = { state: ExternalSetupState; lastSeenAt: Date | string | null };

function serverOrigin(): string {
  return typeof window !== "undefined" && window.location.origin
    ? window.location.origin
    : "https://coforge.example";
}

export function externalAgentProfileSlug(workspaceSlug: string, agentName: string): string {
  return `${workspaceSlug}-${agentName}`;
}

export function externalAgentPrompt(workspaceSlug: string, agentName: string): string {
  const origin = serverOrigin();
  const profile = externalAgentProfileSlug(workspaceSlug, agentName);
  return m.external_agent_prompt({
    name: agentName,
    install: `curl -fsSL ${origin}/cli/install.sh | sh`,
    installWindows: `irm ${origin}/cli/install.ps1 | iex`,
    login: `coforge agent login --server ${origin} --agent ${agentName} --profile ${profile}`,
    profile,
  });
}

function useCopied(): [boolean, (text: string) => Promise<void>] {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return [copied, copy];
}

export function CopyBlock({
  label,
  hint,
  text,
  testId,
}: {
  label: string;
  hint?: string;
  text: string;
  testId?: string;
}) {
  const [copied, copy] = useCopied();
  return (
    <div className="rounded-lg border border-secondary bg-secondary_subtle p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-primary">{label}</p>
          {hint ? <p className="mt-0.5 text-xs text-tertiary">{hint}</p> : null}
        </div>
        <Button
          type="button"
          size="sm"
          color="secondary"
          className="shrink-0"
          iconLeading={copied ? Check : Copy01}
          onPress={() => void copy(text)}
        >
          {copied ? m.external_agent_copied() : m.external_agent_copy()}
        </Button>
      </div>
      <pre
        data-testid={testId}
        className="mt-2 max-h-48 overflow-y-auto font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] text-primary select-all"
      >
        {text}
      </pre>
    </div>
  );
}

export function ExternalAgentPromptBlock({
  workspaceSlug,
  agentName,
}: {
  workspaceSlug: string;
  agentName: string;
}) {
  return (
    <CopyBlock
      label={m.external_agent_prompt_label()}
      text={externalAgentPrompt(workspaceSlug, agentName)}
      testId="external-agent-prompt"
    />
  );
}

export function ExternalAgentCredentialBlock({ credentialKey }: { credentialKey: string }) {
  return (
    <CopyBlock
      label={m.external_agent_credential_label()}
      hint={m.external_agent_credential_hint()}
      text={credentialKey}
      testId="external-agent-credential"
    />
  );
}

function stateTone(state: ExternalSetupState) {
  if (state === "online") return "online" as const;
  if (state === "disconnected") return "error" as const;
  return "offline" as const;
}

export function ExternalConnectionState({
  setup,
  displayName,
  timeZone,
}: {
  setup: ExternalSetup;
  displayName: string;
  timeZone: string | null;
}) {
  return (
    <p
      data-testid="external-agent-state"
      data-state={setup.state}
      className="flex min-w-0 items-center gap-2 text-sm text-secondary"
    >
      <StatusDot tone={stateTone(setup.state)} className="size-2 shrink-0" />
      <span className="min-w-0 break-words">
        {setup.state === "waiting" && m.external_agent_state_waiting({ name: displayName })}
        {setup.state === "disconnected" &&
          m.external_agent_state_disconnected({ name: displayName })}
        {setup.state === "online" && (
          <>
            {m.external_agent_state_online()}
            {setup.lastSeenAt ? (
              <span className="text-tertiary">
                {" · "}
                {m.external_agent_state_active()}{" "}
                <RelativeTime value={setup.lastSeenAt} timeZone={timeZone} />
              </span>
            ) : null}
          </>
        )}
        {setup.state === "offline" && (
          <>
            {m.external_agent_state_offline()}
            {setup.lastSeenAt ? (
              <span className="text-tertiary">
                {" · "}
                {m.external_agent_state_last_seen()}{" "}
                <RelativeTime value={setup.lastSeenAt} timeZone={timeZone} />
              </span>
            ) : null}
          </>
        )}
      </span>
    </p>
  );
}
