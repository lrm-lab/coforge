import { useEffect, useId, useState, type ReactNode } from "react";
import { Check, Copy01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { RelativeTime } from "#src/components/ui/relative-time";
import { StatusDot, type StatusTone } from "#src/components/ui/status-dot";
import { copyText } from "#src/lib/clipboard";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

export type ExternalSetupState = "waiting" | "online" | "offline" | "disconnected";

export type ExternalSetup = { state: ExternalSetupState; lastSeenAt: Date | string | null };

function serverOrigin(): string {
  return typeof window !== "undefined" && window.location.origin
    ? window.location.origin
    : "https://coforge.example";
}

function externalAgentProfileSlug(workspaceSlug: string, agentName: string): string {
  return `${workspaceSlug}-${agentName}`;
}

function externalAgentPrompt(workspaceSlug: string, agentName: string, me: string | null): string {
  const origin = serverOrigin();
  const profile = externalAgentProfileSlug(workspaceSlug, agentName);
  const values = {
    name: agentName,
    install: `curl -fsSL ${origin}/cli/install.sh | sh`,
    installWindows: `irm ${origin}/cli/install.ps1 | iex`,
    login: `coforge agent login --server ${origin} --agent ${agentName} --profile ${profile}`,
    profile,
  };
  return me
    ? m.external_agent_prompt({ ...values, me })
    : m.external_agent_prompt_no_recipient(values);
}

function useCopied(): [boolean, (text: string) => Promise<void>] {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  async function copy(text: string) {
    setCopied(await copyText(text));
  }
  return [copied, copy];
}

export function ExternalSetupStep({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-primary">{title}</h3>
      {children}
    </section>
  );
}

export function ExternalAgentPromptBlock({
  workspaceSlug,
  agentName,
  me,
}: {
  workspaceSlug: string;
  agentName: string;
  me: string | null;
}) {
  const text = externalAgentPrompt(workspaceSlug, agentName, me);
  const [copied, copy] = useCopied();
  const [expanded, setExpanded] = useState(false);
  const promptId = useId();
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-secondary bg-secondary_subtle px-3 py-2.5">
        <pre
          id={promptId}
          data-testid="external-agent-prompt"
          className={cn(
            "font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] text-primary",
            !expanded && "max-h-14 overflow-hidden",
          )}
        >
          {text}
        </pre>
        <Button
          size="sm"
          color="link-gray"
          className="mt-2"
          aria-expanded={expanded}
          aria-controls={promptId}
          onPress={() => setExpanded((open) => !open)}
        >
          {expanded ? m.external_agent_prompt_collapse() : m.external_agent_prompt_expand()}
        </Button>
      </div>
      <Button
        type="button"
        size="sm"
        iconLeading={copied ? Check : Copy01}
        onPress={() => void copy(text)}
      >
        {copied ? m.external_agent_copied() : m.external_agent_copy_prompt()}
      </Button>
    </div>
  );
}

export function ExternalAgentCredentialBlock({
  credentialKey,
  agentName,
}: {
  credentialKey: string;
  agentName: string;
}) {
  const [copied, copy] = useCopied();
  return (
    <div className="space-y-2">
      <p className="text-sm text-tertiary">
        {m.external_agent_credential_hint({ name: agentName })}
      </p>
      <div className="flex items-start gap-2">
        <pre
          data-testid="external-agent-credential"
          className="min-w-0 flex-1 rounded-lg border border-secondary bg-secondary_subtle px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] text-primary select-all"
        >
          {credentialKey}
        </pre>
        <Button
          type="button"
          size="sm"
          color="secondary"
          className="shrink-0"
          iconLeading={copied ? Check : Copy01}
          onPress={() => void copy(credentialKey)}
        >
          {copied ? m.external_agent_copied() : m.external_agent_copy()}
        </Button>
      </div>
      <p className="text-xs text-tertiary">{m.external_agent_credential_keep_out()}</p>
    </div>
  );
}

function stateTone(state: ExternalSetupState): StatusTone {
  if (state === "online") return "online";
  if (state === "offline") return "external";
  if (state === "disconnected") return "error";
  return "offline";
}

export function ExternalConnectionState({
  setup,
  displayName: name,
  timeZone,
  hasCredential = true,
  onCreate = false,
  askOwner,
}: {
  setup: ExternalSetup;
  displayName: string;
  timeZone: string | null;
  hasCredential?: boolean;
  onCreate?: boolean;
  askOwner?: string;
}) {
  const seen = setup.lastSeenAt ? (
    <RelativeTime value={setup.lastSeenAt} timeZone={timeZone} plain />
  ) : null;
  let title: ReactNode;
  let hint: ReactNode;
  if (setup.state === "online") {
    title = onCreate ? m.external_agent_state_connected({ name }) : m.external_agent_state_online();
    hint = onCreate ? (
      m.external_agent_state_connected_hint({ name })
    ) : seen ? (
      <>
        {m.external_agent_state_active()} {seen}
      </>
    ) : (
      m.external_agent_state_signed_in()
    );
  } else if (setup.state === "offline") {
    title = seen ? (
      <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span>{m.external_agent_state_offline()}</span>
        <span className="font-normal text-tertiary">
          {m.external_agent_state_last_seen()} {seen}
        </span>
      </span>
    ) : (
      m.external_agent_state_offline()
    );
    hint = m.external_agent_state_offline_hint();
  } else if (setup.state === "disconnected") {
    title = m.external_agent_state_disconnected({ name });
    hint = m.external_agent_state_disconnected_hint({ name });
  } else {
    title = m.external_agent_state_waiting({ name });
    hint = hasCredential
      ? m.external_agent_state_waiting_hint({ name })
      : m.external_agent_state_no_credential_hint({ name });
  }
  if (askOwner && (setup.state === "waiting" || setup.state === "disconnected"))
    hint = m.external_agent_ask_for_credential({ owner: askOwner });
  return (
    <div
      data-testid="external-agent-state"
      data-state={setup.state}
      className="flex items-start gap-3 rounded-lg border border-secondary px-4 py-3"
    >
      <StatusDot tone={stateTone(setup.state)} className="mt-1.5 size-2 shrink-0" />
      <div className="min-w-0">
        <p className="text-sm font-semibold break-words text-primary">{title}</p>
        <p className="text-sm break-words text-tertiary">{hint}</p>
      </div>
    </div>
  );
}
