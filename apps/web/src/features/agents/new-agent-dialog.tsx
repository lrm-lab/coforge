import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Radio, RadioGroup } from "react-aria-components";

import {
  getComputerRuntimeCatalog,
  listComputers,
} from "#src/features/computers/computers.functions";
import { useCloseConversationList } from "#src/features/conversations/conversation-navigation";
import { useOpenDirectConversation } from "#src/features/conversations/open-direct-conversation";
import { useRefreshSidebar } from "#src/features/conversations/sidebar-lists";
import { Spinner } from "#src/components/ui/spinner";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
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
 * "New agent" from the + menu and the Members page: a two-way switch under the title says where
 * the Agent runs, in the cloud (the default) or on a connected Computer; the picture above shows
 * the chosen one and its fields follow below.
 * Either way it ends in the new Agent's direct conversation.
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
      <NewAgentForms
        open={open}
        busy={busy}
        onClose={() => onOpenChange(false)}
        onBusyChange={setBusy}
      />
    </AgentCreateModal>
  );
}

const KINDS = [
  { id: "cloud", label: m.agent_create_kind_cloud },
  { id: "local", label: m.agent_create_kind_local },
] as const;

type AgentKind = (typeof KINDS)[number]["id"];

/** Mounted with the dialog's content, so every opening starts on the cloud form. The head sits
 * outside the forms, so switching kinds keeps the switch (and the focus on it) in place. */
function NewAgentForms({
  open,
  busy,
  onClose,
  onBusyChange,
}: {
  open: boolean;
  /** A conversation is opening: the dialog stays, and so does the kind. */
  busy: boolean;
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [kind, setKind] = useState<AgentKind>("cloud");
  // Once the switch has been used, the focus stays on it.
  const [switched, setSwitched] = useState(false);
  // A cloud create still preparing may be closed, but not switched away from.
  const [submitting, setSubmitting] = useState(false);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AgentCreateIntro
        illustration={kind}
        title={m.header_new_agent()}
        onClose={busy ? undefined : onClose}
      >
        <RadioGroup
          aria-label={m.agent_create_kind_label()}
          orientation="horizontal"
          value={kind}
          onChange={(next) => {
            setKind(next as AgentKind);
            setSwitched(true);
          }}
          isDisabled={busy || submitting}
          className="mt-4 grid w-full grid-cols-2 gap-0.5 rounded-lg bg-secondary p-0.5"
        >
          {KINDS.map((option) => (
            <Radio
              key={option.id}
              value={option.id}
              className={({ isSelected, isFocusVisible, isDisabled }) =>
                cx(
                  "flex h-8 cursor-pointer items-center justify-center rounded-md text-sm font-medium transition duration-100 ease-linear",
                  isSelected
                    ? "bg-primary text-primary shadow-xs ring-1 ring-primary"
                    : "text-tertiary hover:text-secondary",
                  isFocusVisible && "outline-2 outline-offset-2 outline-focus-ring",
                  isDisabled && "cursor-not-allowed",
                )
              }
            >
              {option.label()}
            </Radio>
          ))}
        </RadioGroup>
      </AgentCreateIntro>
      {kind === "local" ? (
        <NewLocalAgent onClose={onClose} onBusyChange={onBusyChange} />
      ) : (
        <CloudAgentForm
          open={open}
          onClose={onClose}
          onBusyChange={onBusyChange}
          onSubmittingChange={setSubmitting}
          autoFocus={!switched}
        />
      )}
    </div>
  );
}

/** The local form with what it needs: the Workspace's Computers, read each time it is shown (one
 * may have come online since), and a create that opens the new Agent's direct conversation. */
function NewLocalAgent({
  onClose,
  onBusyChange,
}: {
  onClose: () => void;
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
      headless
      onBusyChange={onBusyChange}
    />
  );
}
