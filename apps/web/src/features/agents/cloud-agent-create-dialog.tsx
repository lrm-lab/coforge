import { useEffect, useRef, useState, type FormEvent } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { Cloud01 } from "@untitledui/icons";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { Button } from "#src/components/base/buttons/button";
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

export function CloudAgentCreateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const create = useServerFn(createCloudAgent);
  const refreshDirectory = useRefreshAgentDirectory();
  const queryClient = useQueryClient();
  const workspaceId = useCurrentWorkspaceId();
  const refreshSidebar = useRefreshSidebar({ throwOnError: true });
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [submitting, guard] = useSubmitGuard();
  const request = useRef<{ name: string; requestId: string } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const openingDirect = useRef(false);
  const [opening, setOpening] = useState(false);
  const openDirect = useOpenDirectConversation(() => setError(m.conversation_open_error()));
  const closeList = useCloseConversationList();
  useEffect(() => () => controller.current?.abort(), []);

  function changeOpen(nextOpen: boolean) {
    if (!nextOpen && openingDirect.current) return;
    if (!nextOpen) controller.current?.abort();
    onOpenChange(nextOpen);
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
              changeOpen(false);
              setName("");
              request.current = null;
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
    <ModalOverlay isOpen={open} onOpenChange={changeOpen}>
      <Modal className="w-[calc(100vw-2rem)] max-w-md rounded-2xl">
        <Dialog>
          <form onSubmit={submit}>
            <DialogHeader
              title={m.cloud_agent_create_title()}
              description={m.cloud_agent_create_description()}
              onClose={opening ? undefined : () => changeOpen(false)}
              className="px-4 pt-4 sm:px-6 sm:pt-6"
            />
            <div className="flex flex-col gap-4 px-4 py-6 sm:px-6">
              <Cloud01 aria-hidden="true" className="mx-auto size-12 text-quaternary" />
              <Input
                label={m.cloud_agent_create_name()}
                value={name}
                onChange={setName}
                maxLength={AGENT_DISPLAY_NAME_MAX_LENGTH}
                isRequired
                isDisabled={submitting}
                autoFocus
              />
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
            <div className="flex justify-end gap-3 border-t border-secondary px-4 py-4 sm:px-6">
              <Button color="secondary" isDisabled={opening} onPress={() => changeOpen(false)}>
                {m.controls_cancel()}
              </Button>
              <Button type="submit" isDisabled={submitting || !name.trim()} isLoading={submitting}>
                {m.cloud_agent_create_submit()}
              </Button>
            </div>
          </form>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
