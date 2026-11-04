import { useEffect, useRef, useState, type FormEvent } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { m } from "#src/paraglide/messages";
import { useOpenDirectConversation } from "#src/features/conversations/open-direct-conversation";
import { useCloseConversationList } from "#src/features/conversations/conversation-navigation";
import { useRefreshSidebar } from "#src/features/conversations/sidebar-lists";
import { useCurrentWorkspaceId, useRefreshAgentDirectory } from "./workspace-agents-realtime";
import { agentCreateErrorMessage } from "./agent-form";
import { createCloudAgent } from "./cloud-agents.functions";
import { AgentCreateFooter, AgentCreateForm } from "./agent-create-frame";
import { finishedAgentUsername } from "./agent-username";
import { AgentUsernameField } from "./agent-username-field";

/** The new-Agent dialog's cloud form, under its kind cards: a name, then the Agent is made on the
 * Workspace's cloud Computer and its direct conversation opens. `onBusyChange` keeps the dialog up
 * while the conversation opens; `onSubmittingChange` holds the kind cards while a create runs. */
export function CloudAgentForm({
  open,
  onClose,
  onBusyChange,
  onSubmittingChange,
  autoFocus,
}: {
  /** False from the moment the dialog closes: a create still waiting stops then, not after the
   * close animation, so a closed dialog never opens a conversation. */
  open: boolean;
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
  onSubmittingChange: (submitting: boolean) => void;
  /** Whether the name takes the focus: as the dialog opens, not when the kind switch shows it. */
  autoFocus: boolean;
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
      // One request id for the form's life: after a timeout, a lost response or a failed DM
      // navigation the server returns the Agent this request already made, even under a name
      // edited since; after a refusal (a taken name) nothing was made, and the new name is used.
      const request = { name, requestId };
      const active = new AbortController();
      controller.current = active;
      try {
        const deadline = Date.now() + 120_000;
        while (!active.signal.aborted) {
          const result = await create({ data: request, signal: active.signal });
          if (active.signal.aborted) return;
          if (result.status !== "preparing") {
            try {
              // Creation committed even if its realtime directory signal was lost.
              await Promise.all([
                refreshDirectory(),
                queryClient.invalidateQueries(
                  { queryKey: ["direct-message-directory", workspaceId] },
                  { throwOnError: true },
                ),
              ]);
            } catch {
              if (active.signal.aborted) return;
              setError(
                result.status === "start-deferred"
                  ? m.cloud_agent_create_start_deferred()
                  : m.cloud_agent_create_refresh_error(),
              );
              return;
            }
            if (active.signal.aborted) return;
          }
          if (result.status === "start-deferred") {
            setError(m.cloud_agent_create_start_deferred());
            return;
          }
          if (result.status === "created") {
            openingDirect.current = true;
            setOpening(true);
            let opened;
            try {
              if (await openDirect({ agentId: result.agentId })) {
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
              close();
            }
            return;
          }
          if (Date.now() >= deadline) {
            setError(m.cloud_agent_create_timeout());
            return;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 2000));
        }
      } catch (cause) {
        if (active.signal.aborted) return;
        setError(agentCreateErrorMessage(cause));
      }
    });
  }

  return (
    <AgentCreateForm
      onSubmit={submit}
      footer={
        <AgentCreateFooter
          onCancel={close}
          cancelDisabled={opening}
          submitLabel={m.agent_create_submit_chat()}
          submitting={submitting}
        />
      }
    >
      <div className="flex flex-col gap-3 px-6 pt-5 pb-2">
        <AgentUsernameField autoFocus={autoFocus} isReadOnly={submitting} />
        {/* The server makes every cloud Agent private (task #526): say so before it is made. */}
        {!submitting && (
          <p className="text-sm text-tertiary">{m.cloud_agent_create_private_note()}</p>
        )}
        {submitting && (
          <p role="status" className="text-sm text-tertiary">
            {m.cloud_agent_create_preparing()}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-error-primary">
            {error}
          </p>
        )}
      </div>
    </AgentCreateForm>
  );
}
