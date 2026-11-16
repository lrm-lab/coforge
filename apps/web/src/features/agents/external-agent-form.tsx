import { useEffect, useState, type FormEvent } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Check, Copy01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { TextArea } from "#src/components/base/textarea/textarea";
import { StatusDot } from "#src/components/ui/status-dot";
import { useOpenDirectConversation } from "#src/features/conversations/open-direct-conversation";
import { useCloseConversationList } from "#src/features/conversations/conversation-navigation";
import { useRefreshSidebar } from "#src/features/conversations/sidebar-lists";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { m } from "#src/paraglide/messages";
import { createExternalAgent } from "./agents.functions";
import { agentCreateErrorMessage } from "./agent-form";
import { AgentCreateFooter, AgentCreateForm } from "./agent-create-frame";
import { finishedAgentUsername } from "./agent-username";
import { AgentUsernameField } from "./agent-username-field";
import { useRefreshAgentDirectory } from "./workspace-agents-realtime";

export function externalAgentInstallCommand(): string {
  const origin =
    typeof window !== "undefined" && window.location.origin
      ? window.location.origin
      : "https://coforge.example";
  return `curl -fsSL ${origin}/computer/install.sh | sh && ln -sf "$HOME/.coforge/computer/install/active/coforge" "\${XDG_BIN_HOME:-$HOME/.local/bin}/coforge"`;
}

export function externalAgentLoginCommand(workspaceSlug: string, agentName: string): string {
  const origin =
    typeof window !== "undefined" && window.location.origin
      ? window.location.origin
      : "https://coforge.example";
  return `coforge agent login --server ${origin} --workspace ${workspaceSlug} --agent ${agentName}`;
}

export function ExternalAgentCommandBox({
  workspaceSlug,
  agentName,
}: {
  workspaceSlug: string;
  agentName: string;
}) {
  const [copiedKey, setCopiedKey] = useState<"install" | "login" | null>(null);
  const installCommand = externalAgentInstallCommand();
  const loginCommand = externalAgentLoginCommand(workspaceSlug, agentName);

  useEffect(() => {
    if (!copiedKey) return;
    const timer = window.setTimeout(() => setCopiedKey(null), 2000);
    return () => window.clearTimeout(timer);
  }, [copiedKey]);

  async function copy(key: "install" | "login", text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
    } catch {
      // Clipboard may be blocked; the command remains selectable.
    }
  }

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-secondary bg-secondary_subtle p-3">
        <p className="text-xs font-medium text-primary">{m.external_agent_install_label()}</p>
        <pre className="mt-2 overflow-x-auto font-mono text-xs leading-relaxed break-all whitespace-pre-wrap text-primary select-all">
          {installCommand}
        </pre>
        <div className="mt-2 flex justify-end">
          <Button
            type="button"
            size="sm"
            color="secondary"
            iconLeading={copiedKey === "install" ? Check : Copy01}
            onPress={() => void copy("install", installCommand)}
          >
            {copiedKey === "install"
              ? m.external_agent_connect_copied()
              : m.external_agent_connect_copy()}
          </Button>
        </div>
      </div>

      <div className="rounded-lg border border-secondary bg-secondary_subtle p-3">
        <p className="text-xs font-medium text-primary">{m.external_agent_login_label()}</p>
        <pre className="mt-2 overflow-x-auto font-mono text-xs leading-relaxed break-all whitespace-pre-wrap text-primary select-all">
          {loginCommand}
        </pre>
        <div className="mt-2 flex justify-end">
          <Button
            type="button"
            size="sm"
            color="secondary"
            iconLeading={copiedKey === "login" ? Check : Copy01}
            onPress={() => void copy("login", loginCommand)}
          >
            {copiedKey === "login"
              ? m.external_agent_connect_copied()
              : m.external_agent_connect_copy()}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ExternalAgentForm({
  onClose,
  conversationReplacesPage,
  onBusyChange,
  onSubmittingChange,
  autoFocus,
}: {
  onClose: () => void;
  conversationReplacesPage: boolean;
  onBusyChange: (busy: boolean) => void;
  onSubmittingChange: (submitting: boolean) => void;
  autoFocus: boolean;
}) {
  const create = useServerFn(createExternalAgent);
  const refreshDirectory = useRefreshAgentDirectory();
  const refreshSidebar = useRefreshSidebar({ throwOnError: false });
  const openDirect = useOpenDirectConversation();
  const closeList = useCloseConversationList();
  const workspaceSlug = useWorkspaceSlug();
  const [error, setError] = useState("");
  const [submitting, guard] = useSubmitGuard();
  const [createdAgent, setCreatedAgent] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    onSubmittingChange(submitting);
    return () => onSubmittingChange(false);
  }, [submitting, onSubmittingChange]);

  useEffect(() => {
    onBusyChange(createdAgent !== null);
    return () => onBusyChange(false);
  }, [createdAgent, onBusyChange]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = finishedAgentUsername(String(form.get("name") ?? ""));
    if (!name) {
      setError(m.agent_form_username_required());
      return;
    }
    const displayName = String(form.get("displayName") ?? "").trim();
    const description = String(form.get("description") ?? "").trim();
    await guard(async () => {
      setError("");
      try {
        const result = await create({
          data: {
            hosting: "external",
            name,
            displayName: displayName || undefined,
            description,
          },
        });
        await Promise.all([
          refreshDirectory().catch(() => undefined),
          refreshSidebar(["dms"]).catch(() => undefined),
        ]);
        setCreatedAgent({ id: result.agent.id, name: result.agent.name });
      } catch (caught) {
        setError(agentCreateErrorMessage(caught));
      }
    });
  }

  async function finish() {
    if (!createdAgent) {
      onClose();
      return;
    }
    if (await openDirect({ agentId: createdAgent.id }, { replace: conversationReplacesPage })) {
      closeList();
      if (conversationReplacesPage) return;
    }
    onClose();
  }

  if (createdAgent) {
    return (
      <AgentCreateForm
        footer={
          <div className="flex items-center justify-end gap-3 border-t border-secondary px-6 py-4">
            <Button type="button" size="md" onPress={() => void finish()}>
              {m.external_agent_connect_done()}
            </Button>
          </div>
        }
      >
        <div className="space-y-4 px-6 pt-5 pb-4">
          <div>
            <h3 className="text-sm font-semibold text-primary">
              {m.external_agent_connect_title()}
            </h3>
            <p className="mt-1 text-sm text-tertiary">{m.external_agent_connect_description()}</p>
          </div>
          <ExternalAgentCommandBox workspaceSlug={workspaceSlug} agentName={createdAgent.name} />
          <div className="flex items-center gap-2 text-xs text-tertiary">
            <StatusDot tone="idle" />
            <span>{m.external_agent_connect_waiting()}</span>
          </div>
        </div>
      </AgentCreateForm>
    );
  }

  return (
    <AgentCreateForm
      onSubmit={submit}
      footer={
        <AgentCreateFooter
          onCancel={onClose}
          submitLabel={m.external_agent_create_submit()}
          submitting={submitting}
        />
      }
    >
      <div className="space-y-4 px-6 pt-5 pb-4">
        <AgentUsernameField autoFocus={autoFocus} isReadOnly={submitting} />
        <Input name="displayName" label={m.agent_profile_display_name()} isDisabled={submitting} />
        <TextArea
          name="description"
          label={m.agent_create_description()}
          placeholder={m.agent_form_description_placeholder()}
          rows={2}
          isDisabled={submitting}
        />
        {error ? (
          <p role="alert" className="text-sm text-error-primary">
            {error}
          </p>
        ) : null}
      </div>
    </AgentCreateForm>
  );
}
