import { useEffect, useRef, useState, type FormEvent } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { Cloud01, RefreshCw01 } from "@untitledui/icons";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Input } from "#src/components/base/input/input";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { m } from "#src/paraglide/messages";
import { useOpenDirectConversation } from "#src/features/conversations/open-direct-conversation";
import { useCloseConversationList } from "#src/features/conversations/conversation-navigation";
import { useRefreshSidebar } from "#src/features/conversations/sidebar-lists";
import { useCurrentWorkspaceId, useRefreshAgentDirectory } from "./workspace-agents-realtime";
import { AGENT_DISPLAY_NAME_MAX_LENGTH } from "./agent.schemas";
import { agentCreateErrorMessage } from "./agent-form";
import { createCloudAgent } from "./cloud-agents.functions";
import { AgentCreateFooter, AgentCreateForm, AgentCreateIntro } from "./agent-create-frame";
import { randomAgentUsername } from "./agent-username";

/** The new-Agent dialog's cloud form: a name, then the Agent is made on the Workspace's cloud
 * Computer and its direct conversation opens. `onBusyChange` keeps the dialog up while it runs. */
export function CloudAgentForm({
  open,
  onClose,
  onSwitchToLocal,
  onBusyChange,
}: {
  /** False from the moment the dialog closes: a create still waiting stops then, not after the
   * close animation, so a closed dialog never opens a conversation. */
  open: boolean;
  onClose: () => void;
  onSwitchToLocal?: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const create = useServerFn(createCloudAgent);
  const refreshDirectory = useRefreshAgentDirectory();
  const queryClient = useQueryClient();
  const workspaceId = useCurrentWorkspaceId();
  const refreshSidebar = useRefreshSidebar({ throwOnError: true });
  const [name, setName] = useState(() => randomAgentUsername());
  const [error, setError] = useState("");
  const [submitting, guard] = useSubmitGuard();
  const request = useRef<{ name: string; requestId: string } | null>(null);
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

  function close() {
    if (openingDirect.current) return;
    controller.current?.abort();
    onClose();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) return;
    await guard(async () => {
      setError("");
      // Preserve the request across a timeout, lost response, or a failed DM navigation.
      if (request.current?.name !== name.trim())
        request.current = { name: name.trim(), requestId: crypto.randomUUID() };
      const active = new AbortController();
      controller.current = active;
      try {
        const deadline = Date.now() + 120_000;
        while (!active.signal.aborted) {
          const result = await create({ data: request.current, signal: active.signal });
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
      switchTo={
        onSwitchToLocal && {
          label: m.agent_create_switch_local(),
          onPress: onSwitchToLocal,
          isDisabled: submitting,
        }
      }
      intro={
        <AgentCreateIntro
          icon={Cloud01}
          title={m.cloud_agent_create_title()}
          description={m.cloud_agent_create_description()}
          onClose={opening ? undefined : close}
        />
      }
      footer={
        <AgentCreateFooter
          onCancel={close}
          cancelDisabled={opening}
          submitLabel={m.agent_create_submit_chat()}
          submitting={submitting}
          submitDisabled={!name.trim()}
        />
      }
    >
      <div className="flex flex-col gap-3 px-6 pt-5 pb-2">
        <div className="relative min-w-0">
          <Input
            label={m.cloud_agent_create_name()}
            value={name}
            onChange={setName}
            maxLength={AGENT_DISPLAY_NAME_MAX_LENGTH}
            isRequired
            hideRequiredIndicator
            isReadOnly={submitting}
            autoFocus
          />
          <div className="absolute top-0 right-0 flex h-5 items-center">
            <ButtonUtility
              icon={RefreshCw01}
              size="xs"
              color="tertiary"
              tooltip={m.agent_form_username_suggest()}
              isDisabled={submitting}
              onClick={() => setName((current) => randomAgentUsername(current))}
            />
          </div>
        </div>
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
