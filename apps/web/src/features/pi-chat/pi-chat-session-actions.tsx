import { useState } from "react";
import { Heading } from "react-aria-components";
import { useServerFn } from "@tanstack/react-start";
import { DotsHorizontal, Edit03, Trash01 } from "@untitledui/icons";
import type { PiChatSession } from "@lrm/coforge-sdk/internal/pi-chat";
import { Button } from "#src/components/base/buttons/button";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Input } from "#src/components/base/input/input";
import { Dialog, Modal, ModalOverlay } from "#src/components/application/modals/modal";
import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { m } from "#src/paraglide/messages";
import { executePiChat } from "./pi-chat.functions";

/** The same discoverable actions work from a session row and its open conversation. */
export function PiChatSessionActions({
  session,
  computerId,
  controls,
  onChanged,
  onDeleted,
}: {
  session: PiChatSession;
  computerId: string;
  controls: boolean;
  onChanged(): void;
  onDeleted(): void;
}) {
  const execute = useServerFn(executePiChat);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const running = session.status === "running";
  return (
    <>
      <Dropdown.Root>
        <Button
          size="sm"
          color="tertiary"
          iconLeading={DotsHorizontal}
          aria-label={m.pi_chat_actions()}
        />
        <Dropdown.Popover>
          <Dropdown.Menu aria-label={m.pi_chat_actions()}>
            <Dropdown.Item
              id="rename"
              icon={Edit03}
              isDisabled={running}
              onAction={() => {
                setTitle(session.title);
                setError(false);
                setRenaming(true);
              }}
            >
              {m.pi_chat_rename()}
            </Dropdown.Item>
            <Dropdown.Item id="delete" icon={Trash01} onAction={() => setDeleting(true)}>
              {running ? m.pi_chat_stop_delete() : m.pi_chat_delete()}
            </Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown.Root>
      <ModalOverlay
        isOpen={renaming}
        onOpenChange={(open) => {
          if (!pending) setRenaming(open);
        }}
      >
        <Modal className="w-[calc(100vw-2rem)] max-w-lg">
          <Dialog className="p-6">
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (pending || !title.trim()) return;
                setPending(true);
                setError(false);
                void execute({
                  data: { computerId, command: { action: "rename", sessionId: session.id, title } },
                })
                  .then(() => {
                    setRenaming(false);
                    onChanged();
                  })
                  .catch(() => setError(true))
                  .finally(() => setPending(false));
              }}
            >
              <Heading slot="title" className="text-lg font-semibold text-primary">
                {m.pi_chat_rename()}
              </Heading>
              <Input
                aria-label={m.pi_chat_name()}
                value={title}
                onChange={setTitle}
                maxLength={120}
                autoFocus
              />
              {error && (
                <p role="alert" className="text-sm text-error-primary">
                  {m.pi_chat_connection_error()}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button color="secondary" isDisabled={pending} onClick={() => setRenaming(false)}>
                  {m.pi_chat_cancel()}
                </Button>
                <Button type="submit" isDisabled={pending || !title.trim()} isLoading={pending}>
                  {m.pi_chat_save()}
                </Button>
              </div>
            </form>
          </Dialog>
        </Modal>
      </ModalOverlay>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={running ? m.pi_chat_stop_delete() : m.pi_chat_delete()}
        description={running ? m.pi_chat_stop_delete_confirm() : m.pi_chat_delete_confirm()}
        confirmLabel={running ? m.pi_chat_stop_delete() : m.pi_chat_delete()}
        errorMessage={m.pi_chat_connection_error()}
        onConfirm={async () => {
          if (running && !controls)
            await execute({
              data: { computerId, command: { action: "stop", sessionId: session.id } },
            });
          await execute({
            data: {
              computerId,
              command: {
                action: "delete",
                sessionId: session.id,
                ...(running && controls ? { stop: true } : {}),
              },
            },
          });
          setDeleting(false);
          onDeleted();
          onChanged();
        }}
      />
    </>
  );
}
