import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { Button } from "#src/components/base/buttons/button";
import { TextArea } from "#src/components/base/textarea/textarea";
import { Popconfirm } from "#src/components/ui/popconfirm";
import { useOpenDirectConversation } from "#src/features/conversations/open-direct-conversation";
import { useCloseConversationList } from "#src/features/conversations/conversation-navigation";
import { useRefreshSidebar } from "#src/features/conversations/sidebar-lists";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { m } from "#src/paraglide/messages";
import { createExternalAgent, deleteAgent } from "./agents.functions";
import { agentCreateErrorMessage } from "./agent-form";
import { AgentCreateFooter, AgentCreateForm } from "./agent-create-frame";
import { finishedAgentUsername } from "./agent-username";
import { AgentUsernameField, type AgentUsernameDraft } from "./agent-username-field";
import { useRefreshAgentDirectory } from "./workspace-agents-realtime";
import {
  ExternalAgentCredentialBlock,
  ExternalAgentPromptBlock,
  ExternalConnectionState,
  ExternalSetupStep,
} from "./external-agent-setup";
import { agentProfileQuery } from "./profile-panel/agent-profile-queries";

export function ExternalAgentForm({
  onClose,
  conversationReplacesPage,
  onBusyChange,
  onSubmittingChange,
  autoFocus,
  usernameDraft,
}: {
  onClose: () => void;
  conversationReplacesPage: boolean;
  onBusyChange: (busy: boolean) => void;
  onSubmittingChange: (submitting: boolean) => void;
  autoFocus: boolean;
  usernameDraft?: AgentUsernameDraft;
}) {
  const create = useServerFn(createExternalAgent);
  const queryClient = useQueryClient();
  const refreshDirectory = useRefreshAgentDirectory();
  const refreshSidebar = useRefreshSidebar({ throwOnError: false });
  const openDirect = useOpenDirectConversation();
  const closeList = useCloseConversationList();
  const workspaceSlug = useWorkspaceSlug();
  const [error, setError] = useState("");
  const [submitting, guard] = useSubmitGuard();
  const [createdAgent, setCreatedAgent] = useState<{
    id: string;
    name: string;
    displayName: string;
    key: string;
  } | null>(null);

  useEffect(() => {
    onSubmittingChange(submitting);
    return () => onSubmittingChange(false);
  }, [submitting, onSubmittingChange]);

  useEffect(() => {
    onBusyChange(createdAgent !== null);
    return () => onBusyChange(false);
  }, [createdAgent, onBusyChange]);

  async function refreshLists() {
    await Promise.all([
      refreshDirectory().catch(() => undefined),
      refreshSidebar(["dms"]).catch(() => undefined),
    ]);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = finishedAgentUsername(String(form.get("name") ?? ""));
    if (!name) {
      setError(m.agent_form_username_required());
      return;
    }
    const description = String(form.get("description") ?? "").trim();
    await guard(async () => {
      setError("");
      try {
        const result = await create({
          data: {
            hosting: "external",
            name,
            description,
          },
        });
        await Promise.all([
          refreshLists(),
          queryClient.prefetchQuery(agentProfileQuery(result.agent.id)),
        ]);
        setCreatedAgent({
          id: result.agent.id,
          name: result.agent.name,
          displayName: result.agent.displayName || result.agent.name,
          key: result.credential.key,
        });
      } catch (caught) {
        setError(agentCreateErrorMessage(caught));
      }
    });
  }

  async function finish(agentId: string) {
    if (await openDirect({ agentId }, { replace: conversationReplacesPage })) {
      closeList();
      if (conversationReplacesPage) return;
    }
    onClose();
  }

  if (createdAgent) {
    return (
      <ExternalAgentConnectStep
        agent={createdAgent}
        workspaceSlug={workspaceSlug}
        onDone={() => void finish(createdAgent.id)}
        onDiscarded={async () => {
          await refreshLists();
          onClose();
        }}
      />
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
        <AgentUsernameField autoFocus={autoFocus} isReadOnly={submitting} draft={usernameDraft} />
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

function ExternalAgentConnectStep({
  agent,
  workspaceSlug,
  onDone,
  onDiscarded,
}: {
  agent: { id: string; name: string; displayName: string; key: string };
  workspaceSlug: string;
  onDone: () => void;
  onDiscarded: () => Promise<void>;
}) {
  const remove = useServerFn(deleteAgent);
  const profile = useQuery({
    ...agentProfileQuery(agent.id),
    refetchInterval: (query) =>
      query.state.data?.externalSetup?.state === "online" ? false : 3000,
  });
  const setup = profile.data?.externalSetup ?? { state: "waiting" as const, lastSeenAt: null };
  const online = setup.state === "online";

  return (
    <AgentCreateForm
      footer={
        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-secondary px-6 py-4">
          {online ? null : (
            <>
              <p className="min-w-0 flex-1 text-sm text-tertiary">
                {m.external_agent_finish_later()}
              </p>
              <Popconfirm
                title={m.external_agent_discard_title({ name: agent.displayName })}
                description={m.external_agent_discard_body()}
                confirmLabel={m.external_agent_discard()}
                errorMessage={m.external_agent_discard_failed()}
                placement="top end"
                onConfirm={async () => {
                  await remove({ data: { agentId: agent.id, confirmation: agent.name } });
                  await onDiscarded();
                }}
              >
                <Button type="button" size="md" color="tertiary">
                  {m.external_agent_cancel()}
                </Button>
              </Popconfirm>
            </>
          )}
          <Button type="button" size="md" color={online ? "primary" : "secondary"} onPress={onDone}>
            {m.external_agent_connect_done()}
          </Button>
        </div>
      }
    >
      <div className="space-y-5 px-6 pt-5 pb-4">
        <ExternalConnectionState
          setup={setup}
          displayName={agent.displayName}
          timeZone={null}
          onCreate
        />
        {online ? null : (
          <>
            {profile.data ? (
              <ExternalSetupStep title={m.external_agent_step_prompt()}>
                <ExternalAgentPromptBlock
                  workspaceSlug={workspaceSlug}
                  agentName={agent.name}
                  me={profile.data.externalConnectTarget}
                />
              </ExternalSetupStep>
            ) : null}
            <ExternalSetupStep title={m.external_agent_step_credential()}>
              <ExternalAgentCredentialBlock credentialKey={agent.key} agentName={agent.name} />
            </ExternalSetupStep>
          </>
        )}
      </div>
    </AgentCreateForm>
  );
}
