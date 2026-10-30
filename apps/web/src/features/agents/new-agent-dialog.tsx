import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Monitor01 } from "@untitledui/icons";

import {
  getComputerRuntimeCatalog,
  listComputers,
} from "#src/features/computers/computers.functions";
import { useCloseConversationList } from "#src/features/conversations/conversation-navigation";
import { useOpenDirectConversation } from "#src/features/conversations/open-direct-conversation";
import { useRefreshSidebar } from "#src/features/conversations/sidebar-lists";
import { Spinner } from "#src/components/ui/spinner";
import { m } from "#src/paraglide/messages";
import {
  AgentCreateFooter,
  AgentCreateForm,
  AgentCreateIntro,
  AgentCreateModal,
} from "./agent-create-frame";
import { LocalAgentForm } from "./agent-create-dialog";
import { createAgent } from "./agents.functions";
import { CloudAgentForm } from "./cloud-agent-form";
import { useCurrentWorkspaceId, useRefreshAgentDirectory } from "./workspace-agents-realtime";

/**
 * "New agent" from the + menu and the Members page (Figma 3745:7147): a cloud Agent by default,
 * a link away from one on the person's own Computer, and back. Either way it ends in the new
 * Agent's direct conversation.
 */
export function NewAgentDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <AgentCreateModal open={open} onOpenChange={onOpenChange} dismissable={!busy}>
      <NewAgentForms open={open} onClose={() => onOpenChange(false)} onBusyChange={setBusy} />
    </AgentCreateModal>
  );
}

/** Mounted with the dialog's content, so every opening starts on the cloud form. */
function NewAgentForms({
  open,
  onClose,
  onBusyChange,
}: {
  open: boolean;
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [local, setLocal] = useState(false);
  return local ? (
    <NewLocalAgent
      onClose={onClose}
      onSwitchToCloud={() => setLocal(false)}
      onBusyChange={onBusyChange}
    />
  ) : (
    <CloudAgentForm
      open={open}
      onClose={onClose}
      onSwitchToLocal={() => setLocal(true)}
      onBusyChange={onBusyChange}
    />
  );
}

/** The local form with what it needs: the Workspace's Computers, read each time it is shown (one
 * may have come online since), and a create that opens the new Agent's direct conversation. */
function NewLocalAgent({
  onClose,
  onSwitchToCloud,
  onBusyChange,
}: {
  onClose: () => void;
  onSwitchToCloud: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const workspaceId = useCurrentWorkspaceId();
  const loadComputers = useServerFn(listComputers);
  const loadRuntimeCatalog = useServerFn(getComputerRuntimeCatalog);
  const create = useServerFn(createAgent);
  const refreshDirectory = useRefreshAgentDirectory();
  const refreshSidebar = useRefreshSidebar({ throwOnError: false });
  const openDirect = useOpenDirectConversation();
  const closeList = useCloseConversationList();
  const computers = useQuery({
    queryKey: ["computers", "agent-create", workspaceId],
    queryFn: () => loadComputers(),
    staleTime: 0,
    gcTime: 0,
  });

  // A failed re-read keeps the Computers already shown; only a first read that fails stops here.
  if (!computers.data)
    return (
      <AgentCreateForm
        switchTo={{ label: m.agent_create_switch_cloud(), onPress: onSwitchToCloud }}
        intro={
          <AgentCreateIntro
            icon={Monitor01}
            title={m.agent_create_local_title()}
            description={m.agent_create_local_description()}
            onClose={onClose}
          />
        }
        footer={
          <AgentCreateFooter
            onCancel={onClose}
            submitLabel={m.agent_create_submit_chat()}
            submitting={false}
            submitDisabled
          />
        }
      >
        {computers.isError ? (
          <p role="alert" className="px-6 pt-5 text-sm text-error-primary">
            {m.channel_members_computers_error()}
          </p>
        ) : (
          <div role="status" className="flex justify-center px-6 pt-5 text-tertiary">
            <Spinner />
            <span className="sr-only">{m.agent_env_loading()}</span>
          </div>
        )}
      </AgentCreateForm>
    );

  return (
    <LocalAgentForm
      computers={computers.data}
      onLoadRuntimeCatalog={(computerId) => loadRuntimeCatalog({ data: { computerId } })}
      submitLabel={m.agent_create_submit_chat()}
      onCreate={async (input) => {
        const created = await create({ data: input });
        await refreshDirectory();
        // The Agent exists now: a conversation that fails to open leaves it in the sidebar.
        if (await openDirect({ agentId: created.agent.id })) {
          await refreshSidebar(["dms"]);
          closeList();
        }
        onClose();
      }}
      onClose={onClose}
      onSwitchToCloud={onSwitchToCloud}
      onBusyChange={onBusyChange}
    />
  );
}
