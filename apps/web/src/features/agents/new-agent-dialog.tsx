import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Heading, Radio, RadioGroup } from "react-aria-components";

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
import { useCreateAgent } from "./use-create-agent";
import { CloudAgentForm } from "./cloud-agent-form";
import { ExternalAgentForm } from "./external-agent-form";
import { useCloudAgentComputer } from "./cloud-agent-computer";
import { useCurrentWorkspaceId } from "./workspace-agents-realtime";

export function NewAgentDialog({
  open,
  onOpenChange,
  conversationReplacesPage = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationReplacesPage?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <AgentCreateModal open={open} onOpenChange={onOpenChange} dismissable={!busy}>
      <NewAgentForms
        open={open}
        busy={busy}
        onClose={() => onOpenChange(false)}
        conversationReplacesPage={conversationReplacesPage}
        onBusyChange={setBusy}
      />
    </AgentCreateModal>
  );
}

const KINDS = [
  { id: "cloud", label: m.agent_create_kind_cloud },
  { id: "local", label: m.agent_create_kind_local },
  { id: "external", label: m.agent_create_kind_external },
] as const;

type AgentKind = (typeof KINDS)[number]["id"];

function NewAgentForms({
  open,
  busy,
  onClose,
  conversationReplacesPage,
  onBusyChange,
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  conversationReplacesPage: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const cloud = useCloudAgentComputer();
  const [chosen, setChosen] = useState<AgentKind>();
  const [submitting, setSubmitting] = useState(false);
  if (cloud.isPending)
    return (
      <Loading className="py-12">
        <Heading slot="title" className="sr-only">
          {m.header_new_agent()}
        </Heading>
      </Loading>
    );
  const cloudComputer = cloud.data?.state === "none" ? undefined : cloud.data;
  const availableKinds = cloudComputer ? KINDS : KINDS.filter((option) => option.id !== "cloud");
  const defaultKind: AgentKind = cloudComputer ? "cloud" : "local";
  const kind: AgentKind =
    chosen && availableKinds.some((option) => option.id === chosen) ? chosen : defaultKind;
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
          onChange={(next) => setChosen(next as AgentKind)}
          isDisabled={busy || submitting}
          className="mt-4 grid w-full auto-cols-fr grid-flow-col gap-0.5 rounded-lg bg-secondary p-0.5"
        >
          {availableKinds.map((option) => (
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
      {kind === "external" ? (
        <ExternalAgentForm
          onClose={onClose}
          conversationReplacesPage={conversationReplacesPage}
          onBusyChange={onBusyChange}
          onSubmittingChange={setSubmitting}
          autoFocus={chosen !== undefined}
        />
      ) : kind === "cloud" && cloudComputer ? (
        <CloudAgentForm
          computer={cloudComputer}
          open={open}
          onClose={onClose}
          conversationReplacesPage={conversationReplacesPage}
          onBusyChange={onBusyChange}
          onSubmittingChange={setSubmitting}
          autoFocus={chosen === undefined}
        />
      ) : (
        <NewLocalAgent
          onClose={onClose}
          conversationReplacesPage={conversationReplacesPage}
          onBusyChange={onBusyChange}
        />
      )}
    </div>
  );
}

function NewLocalAgent({
  onClose,
  conversationReplacesPage,
  onBusyChange,
}: {
  onClose: () => void;
  conversationReplacesPage: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const workspaceId = useCurrentWorkspaceId();
  const loadComputers = useServerFn(listComputers);
  const loadRuntimeCatalog = useServerFn(getComputerRuntimeCatalog);
  const create = useCreateAgent();
  const refreshSidebar = useRefreshSidebar({ throwOnError: false });
  const openDirect = useOpenDirectConversation();
  const closeList = useCloseConversationList();
  const computers = useQuery({
    queryKey: ["computers", "agent-create", workspaceId],
    queryFn: () => loadComputers(),
    staleTime: 0,
    gcTime: 0,
  });

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
          <Loading className="pt-5" />
        )}
      </AgentCreateForm>
    );

  return (
    <LocalAgentForm
      computers={computers.data}
      onLoadRuntimeCatalog={(computerId) => loadRuntimeCatalog({ data: { computerId } })}
      submitLabel={m.agent_create_submit_chat()}
      onCreate={async (input) => {
        const created = await create(input);
        if (
          await openDirect({ agentId: created.agent.id }, { replace: conversationReplacesPage })
        ) {
          await refreshSidebar(["dms"]);
          closeList();
          if (conversationReplacesPage) return;
        }
        onClose();
      }}
      onClose={onClose}
      headless
      onBusyChange={onBusyChange}
    />
  );
}

function Loading({ className, children }: { className: string; children?: ReactNode }) {
  return (
    <div role="status" className={cx("flex justify-center px-6 text-tertiary", className)}>
      {children}
      <Spinner />
      <span className="sr-only">{m.agent_env_loading()}</span>
    </div>
  );
}
