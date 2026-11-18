import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Cloud01, Link01, Monitor01 } from "@untitledui/icons";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Radio, RadioGroup } from "react-aria-components";

import {
  getComputerRuntimeCatalog,
  listComputers,
} from "#src/features/computers/computers.functions";
import { useCloseConversationList } from "#src/features/conversations/conversation-navigation";
import { useOpenDirectConversation } from "#src/features/conversations/open-direct-conversation";
import { useRefreshSidebar } from "#src/features/conversations/sidebar-lists";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import {
  AgentCreateFooter,
  AgentCreateForm,
  AgentCreateIntro,
  AgentCreateModal,
} from "./agent-create-frame";
import { LocalAgentForm } from "./agent-create-dialog";
import {
  FieldsPlaceholder,
  PlaceholderBlock,
  type PlaceholderRow,
} from "./agent-create-placeholder";
import type { RuntimeCatalog } from "./agent-runtime-fields";
import { useCreateAgent } from "./use-create-agent";
import { CloudAgentForm } from "./cloud-agent-form";
import { ExternalAgentForm } from "./external-agent-form";
import { useCloudAgentComputer } from "./cloud-agent-computer";
import { useCurrentWorkspaceId } from "./workspace-agents-realtime";
import { useAgentUsernameDraft, type AgentUsernameDraft } from "./agent-username-field";

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
    <AgentCreateModal
      open={open}
      onOpenChange={onOpenChange}
      dismissable={!busy}
      title={m.header_new_agent()}
    >
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
  { id: "cloud", label: m.agent_create_kind_cloud, icon: Cloud01 },
  { id: "local", label: m.agent_create_kind_local, icon: Monitor01 },
  { id: "external", label: m.agent_create_kind_external, icon: Link01 },
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
  const computers = useAgentCreateComputers();
  const catalogs = useAgentCreateCatalogs(computers.data?.[0]?.id);
  const [chosen, setChosen] = useState<AgentKind>();
  const [submitting, setSubmitting] = useState(false);
  const usernameDraft = useAgentUsernameDraft();
  const heightRef = useDialogHeightTransition(chosen);
  if (cloud.isPending)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <AgentCreateIntro title={m.header_new_agent()} onClose={busy ? undefined : onClose}>
          <PlaceholderBlock className="mt-4 h-9" />
        </AgentCreateIntro>
        <PendingForm onClose={onClose} rows={["field", "line"]} className="gap-3 px-6 pt-5 pb-2" />
      </div>
    );
  const cloudComputer = cloud.data?.state === "none" ? undefined : cloud.data;
  const availableKinds = cloudComputer ? KINDS : KINDS.filter((option) => option.id !== "cloud");
  const defaultKind: AgentKind = cloudComputer ? "cloud" : "local";
  const kind: AgentKind =
    chosen && availableKinds.some((option) => option.id === chosen) ? chosen : defaultKind;
  return (
    <div ref={heightRef} className="flex min-h-0 flex-1 flex-col">
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
                  "flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-md text-sm font-medium transition duration-100 ease-linear",
                  isSelected
                    ? "bg-primary text-primary shadow-xs ring-1 ring-primary"
                    : "text-tertiary hover:text-secondary",
                  isFocusVisible && "outline-2 outline-offset-2 outline-focus-ring",
                  isDisabled && "cursor-not-allowed",
                )
              }
            >
              <option.icon aria-hidden className="size-4 shrink-0" />
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
          usernameDraft={usernameDraft}
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
          usernameDraft={usernameDraft}
        />
      ) : (
        <NewLocalAgent
          onClose={onClose}
          conversationReplacesPage={conversationReplacesPage}
          onBusyChange={onBusyChange}
          usernameDraft={usernameDraft}
          computers={computers}
          catalogs={catalogs}
        />
      )}
    </div>
  );
}

function NewLocalAgent({
  onClose,
  conversationReplacesPage,
  onBusyChange,
  usernameDraft,
  computers,
  catalogs,
}: {
  onClose: () => void;
  conversationReplacesPage: boolean;
  onBusyChange: (busy: boolean) => void;
  usernameDraft: AgentUsernameDraft;
  computers: UseQueryResult<CreateComputer[]>;
  catalogs: AgentCreateCatalogs;
}) {
  const create = useCreateAgent();
  const refreshSidebar = useRefreshSidebar({ throwOnError: false });
  const openDirect = useOpenDirectConversation();
  const closeList = useCloseConversationList();
  if (computers.isError && !computers.data)
    return (
      <PendingForm onClose={onClose}>
        <p role="alert" className="px-6 pt-5 text-sm text-error-primary">
          {m.channel_members_computers_error()}
        </p>
      </PendingForm>
    );
  if (!computers.data)
    return (
      <PendingForm
        onClose={onClose}
        rows={["field", "field", "area", "field", "field", "tall-card", "card"]}
        className="gap-4 px-6 pt-5 pb-3"
      />
    );

  return (
    <LocalAgentForm
      computers={computers.data}
      onLoadRuntimeCatalog={catalogs.load}
      cachedRuntimeCatalog={catalogs.cached}
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
      usernameDraft={usernameDraft}
    />
  );
}

function PendingForm({
  onClose,
  rows,
  className = "",
  children,
}: {
  onClose: () => void;
  rows?: PlaceholderRow[];
  className?: string;
  children?: ReactNode;
}) {
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
      {children ?? <FieldsPlaceholder rows={rows ?? []} className={className} />}
    </AgentCreateForm>
  );
}

type CreateComputer = Awaited<ReturnType<typeof listComputers>>[number];

const createOrder = (computer: CreateComputer) =>
  (computer.online ? 0 : 2) + (computer.kind === "cloud" ? 1 : 0);

function useAgentCreateComputers() {
  const workspaceId = useCurrentWorkspaceId();
  const load = useServerFn(listComputers);
  return useQuery({
    queryKey: ["computers", "agent-create", workspaceId],
    queryFn: async () => [...(await load())].sort((a, b) => createOrder(a) - createOrder(b)),
    staleTime: 0,
    gcTime: 0,
  });
}

type AgentCreateCatalogs = ReturnType<typeof useAgentCreateCatalogs>;

function useAgentCreateCatalogs(defaultComputerId: string | undefined) {
  const workspaceId = useCurrentWorkspaceId();
  const load = useServerFn(getComputerRuntimeCatalog);
  const queryClient = useQueryClient();
  const query = (computerId: string) => ({
    queryKey: ["runtime-catalog", "agent-create", workspaceId, computerId],
    queryFn: (): Promise<RuntimeCatalog[]> => load({ data: { computerId } }),
    staleTime: 0,
  });
  useQuery({ ...query(defaultComputerId ?? ""), enabled: Boolean(defaultComputerId) });
  return {
    load: (computerId: string) =>
      queryClient.ensureQueryData({ ...query(computerId), revalidateIfStale: true }),
    cached: (computerId: string) =>
      queryClient.getQueryData<RuntimeCatalog[]>(query(computerId).queryKey),
  };
}

const HEIGHT_TRANSITION = { duration: 200, easing: "cubic-bezier(0.23, 1, 0.32, 1)" };

function useDialogHeightTransition(key: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const lastHeight = useRef<number>(undefined);
  useLayoutEffect(() => {
    const dialog = ref.current?.closest<HTMLElement>("[role=dialog]");
    if (!dialog) return;
    const from = lastHeight.current;
    const to = dialog.getBoundingClientRect().height;
    lastHeight.current = to;
    const animate =
      from !== undefined &&
      Math.abs(from - to) > 1 &&
      window.matchMedia("(min-width: 640px) and (prefers-reduced-motion: no-preference)").matches;
    if (!animate) return;
    const overflow = dialog.style.overflow;
    dialog.style.overflow = "hidden";
    const animation = dialog.animate(
      [{ height: `${from}px` }, { height: `${to}px` }],
      HEIGHT_TRANSITION,
    );
    const restore = () => {
      dialog.style.overflow = overflow;
    };
    animation.onfinish = restore;
    animation.oncancel = restore;
    return () => animation.cancel();
  }, [key]);
  useLayoutEffect(() => {
    const dialog = ref.current?.closest<HTMLElement>("[role=dialog]");
    if (!dialog) return;
    const observer = new ResizeObserver(() => {
      if (dialog.getAnimations().length === 0)
        lastHeight.current = dialog.getBoundingClientRect().height;
    });
    observer.observe(dialog);
    return () => observer.disconnect();
  }, []);
  return ref;
}
