import { useEffect, useRef, useState, type FormEvent } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "#src/components/base/buttons/button";
import { Spinner } from "#src/components/ui/spinner";
import { StatusDot } from "#src/components/ui/status-dot";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { m } from "#src/paraglide/messages";
import { localizeHref } from "#src/paraglide/runtime";
import { useOpenDirectConversation } from "#src/features/conversations/open-direct-conversation";
import { useCloseConversationList } from "#src/features/conversations/conversation-navigation";
import { useRefreshSidebar } from "#src/features/conversations/sidebar-lists";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { workspacePath } from "#src/features/workspaces/workspace-url";
import { useCurrentWorkspaceId, useRefreshAgentDirectory } from "./workspace-agents-realtime";
import { agentCreateErrorMessage } from "./agent-form";
import { createCloudAgent } from "./cloud-agents.functions";
import { cloudAgentComputerKey, type PlacedCloudAgentComputer } from "./cloud-agent-computer";
import { AgentCreateFooter, AgentCreateForm } from "./agent-create-frame";
import { finishedAgentUsername } from "./agent-username";
import { AgentUsernameField, type AgentUsernameDraft } from "./agent-username-field";

export function CloudAgentForm({
  computer,
  open,
  onClose,
  conversationReplacesPage,
  onBusyChange,
  onSubmittingChange,
  autoFocus,
  usernameDraft,
}: {
  computer: PlacedCloudAgentComputer;
  open: boolean;
  onClose: () => void;
  conversationReplacesPage: boolean;
  onBusyChange: (busy: boolean) => void;
  onSubmittingChange: (submitting: boolean) => void;
  autoFocus: boolean;
  usernameDraft?: AgentUsernameDraft;
}) {
  const create = useServerFn(createCloudAgent);
  const refreshDirectory = useRefreshAgentDirectory();
  const queryClient = useQueryClient();
  const workspaceId = useCurrentWorkspaceId();
  const refreshSidebar = useRefreshSidebar({ throwOnError: true });
  const [error, setError] = useState("");
  const [submitting, guard] = useSubmitGuard();
  const [requestId] = useState(() => crypto.randomUUID());
  const controller = useRef<AbortController | null>(null);
  const openingDirect = useRef(false);
  const [opening, setOpening] = useState(false);
  const openDirect = useOpenDirectConversation(() => setError(m.conversation_open_error()));
  const closeList = useCloseConversationList();
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!open) controller.current?.abort();
  }, [open]);
  useEffect(() => {
    onBusyChange(opening);
    return () => onBusyChange(false);
  }, [opening, onBusyChange]);
  useEffect(() => {
    onSubmittingChange(submitting);
    return () => onSubmittingChange(false);
  }, [submitting, onSubmittingChange]);

  function close() {
    if (openingDirect.current) return;
    controller.current?.abort();
    onClose();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = finishedAgentUsername(String(form.get("name") ?? ""));
    if (!name) {
      setError(m.agent_form_username_required());
      return;
    }
    await guard(async () => {
      setError("");
      const active = new AbortController();
      controller.current = active;
      try {
        const result = await create({ data: { name, requestId }, signal: active.signal });
        if (active.signal.aborted) return;
        if (result.status === "unavailable") {
          void queryClient.invalidateQueries({ queryKey: cloudAgentComputerKey(workspaceId) });
          return;
        }
        const refreshed = await Promise.all([
          refreshDirectory(),
          queryClient.invalidateQueries(
            { queryKey: ["direct-message-directory", workspaceId] },
            { throwOnError: true },
          ),
        ]).then(
          () => true,
          () => false,
        );
        if (active.signal.aborted) return;
        if (result.status === "start-deferred") {
          setError(m.cloud_agent_create_start_deferred());
          return;
        }
        if (!refreshed) {
          setError(m.cloud_agent_create_refresh_error());
          return;
        }
        openingDirect.current = true;
        setOpening(true);
        let opened;
        try {
          if (
            await openDirect({ agentId: result.agentId }, { replace: conversationReplacesPage })
          ) {
            await refreshSidebar(["dms"]);
            opened = true;
          }
        } catch {
          setError(m.cloud_agent_create_refresh_error());
        } finally {
          openingDirect.current = false;
          setOpening(false);
        }
        if (opened) {
          closeList();
          if (!conversationReplacesPage) close();
        }
      } catch (cause) {
        if (active.signal.aborted) return;
        setError(agentCreateErrorMessage(cause));
      }
    });
  }

  const ready = computer.state === "ready";
  return (
    <AgentCreateForm
      onSubmit={submit}
      footer={
        <AgentCreateFooter
          onCancel={close}
          cancelDisabled={opening}
          submitLabel={m.agent_create_submit_chat()}
          submitting={submitting}
          submitDisabled={!ready}
        />
      }
    >
      <div className="flex flex-col gap-3 px-6 pt-5 pb-2">
        {!ready && <CloudComputerStatus computer={computer} onLeave={close} />}
        <AgentUsernameField autoFocus={autoFocus} isReadOnly={submitting} draft={usernameDraft} />
        {ready && <p className="text-sm text-tertiary">{m.cloud_agent_create_private_note()}</p>}
        {error && (
          <p role="alert" className="text-sm text-error-primary">
            {error}
          </p>
        )}
      </div>
    </AgentCreateForm>
  );
}

function CloudComputerStatus({
  computer,
  onLeave,
}: {
  computer: PlacedCloudAgentComputer;
  onLeave: () => void;
}) {
  const workspaceSlug = useWorkspaceSlug();
  const starting = computer.state === "starting";
  return (
    <div
      role="status"
      className="flex items-center gap-2.5 rounded-lg bg-secondary px-3.5 py-3 text-sm text-secondary"
    >
      {starting ? (
        <Spinner className="size-3.5 shrink-0 text-tertiary" />
      ) : (
        <StatusDot tone="offline" className="size-2" />
      )}
      <p className="min-w-0 flex-1">
        {starting ? m.cloud_agent_create_starting() : m.cloud_agent_create_offline()}
      </p>
      {!starting && (
        <Button
          href={localizeHref(workspacePath(workspaceSlug, `/computer/${computer.computerId}`))}
          color="link-color"
          size="sm"
          onClick={onLeave}
        >
          {m.cloud_agent_create_view_computer()}
        </Button>
      )}
    </div>
  );
}
