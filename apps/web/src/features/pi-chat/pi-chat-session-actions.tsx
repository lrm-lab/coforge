import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { useRef, useState } from "react";
import { useStore } from "@tanstack/react-form";
import { Heading } from "react-aria-components";
import { DotsHorizontal, Edit03, Trash01 } from "@untitledui/icons";
import type { PiChatSession } from "@lrm/coforge-sdk/internal/pi-chat";
import { Button } from "#src/components/base/buttons/button";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { setFieldServerError, useAppForm } from "#src/components/ui/form";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { scheduleFocusInvalidField } from "#src/lib/form-field-error";
import { m } from "#src/paraglide/messages";
import { piChatFailureMessage } from "./pi-chat-failure";
import { useExecutePiChat } from "./use-execute-pi-chat";
import {
  DialogAction,
  DialogActions,
  DialogCancel,
  useDialogControlSize,
} from "#src/components/ui/dialog-actions";

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
  const controlSize = useDialogControlSize();
  const execute = useExecutePiChat();
  const formRef = useRef<HTMLFormElement>(null);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const form = useAppForm({
    defaultValues: { title: "" },
    onSubmitInvalid: () => scheduleFocusInvalidField(formRef.current),
    onSubmit: async ({ value }) => {
      if (!value.title.trim()) return;
      try {
        await execute({
          data: {
            computerId,
            command: {
              action: "rename",
              sessionId: session.id,
              title: value.title,
              runtime: session.runtime,
            },
          },
        });
        setRenaming(false);
        onChanged();
      } catch {
        setFieldServerError(form, "title", piChatFailureMessage("action"), formRef.current);
      }
    },
  });
  const { title, pending } = useStore(form.store, (state) => ({
    title: state.values.title,
    pending: state.isSubmitting,
  }));
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
                form.reset({ title: session.title });
                setRenaming(true);
              }}
            >
              {m.pi_chat_rename()}
            </Dropdown.Item>
            <Dropdown.Separator />
            <Dropdown.Item
              id="delete"
              icon={Trash01}
              tone="destructive"
              onAction={() => setDeleting(true)}
            >
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
            <form.AppForm>
              <form
                ref={formRef}
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void form.handleSubmit();
                }}
              >
                <Heading slot="title" className="text-lg font-semibold text-primary">
                  {m.pi_chat_rename()}
                </Heading>
                <form.AppField name="title">
                  {(field) => (
                    <field.Input
                      size={controlSize}
                      aria-label={m.pi_chat_name()}
                      maxLength={120}
                      autoFocus
                    />
                  )}
                </form.AppField>
                <DialogActions>
                  <DialogCancel isDisabled={pending} onPress={() => setRenaming(false)}>
                    {m.pi_chat_cancel()}
                  </DialogCancel>
                  <DialogAction
                    type="submit"
                    isDisabled={pending || !title.trim()}
                    isLoading={pending}
                  >
                    {m.pi_chat_save()}
                  </DialogAction>
                </DialogActions>
              </form>
            </form.AppForm>
          </Dialog>
        </Modal>
      </ModalOverlay>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        tone={session.runtime === RUNTIME_PROVIDER.CODEX ? "default" : "destructive"}
        title={running ? m.pi_chat_stop_delete() : m.pi_chat_delete()}
        description={
          session.runtime === RUNTIME_PROVIDER.CODEX
            ? m.pi_chat_codex_archive_confirm()
            : running
              ? m.pi_chat_stop_delete_confirm()
              : m.pi_chat_delete_confirm()
        }
        confirmLabel={running ? m.pi_chat_stop_delete() : m.pi_chat_delete_action()}
        errorMessage={piChatFailureMessage("action")}
        onConfirm={async () => {
          if (running && !controls)
            await execute({
              data: {
                computerId,
                command: { action: "stop", sessionId: session.id, runtime: session.runtime },
              },
            });
          await execute({
            data: {
              computerId,
              command: {
                action: "delete",
                sessionId: session.id,
                runtime: session.runtime,
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
