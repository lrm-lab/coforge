import { useRef, useState } from "react";
import { XClose as X } from "@untitledui/icons";
import { Heading, Text } from "react-aria-components";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { useAppForm } from "#src/components/ui/form";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import {
  DialogAction,
  DialogActions,
  DialogCancel,
  useDialogControlSize,
} from "#src/components/ui/dialog-actions";
import { m } from "#src/paraglide/messages";
import { isAppError, isAppErrorCode } from "#src/lib/app-error";
import { scheduleFocusInvalidField } from "#src/lib/form-field-error";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";

export function AgentDeleteDialog({
  agentName,
  open,
  onOpenChange,
  onDelete,
}: {
  agentName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete: (confirmation: string) => Promise<void>;
}) {
  const controlSize = useDialogControlSize();
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState("");
  const [bodyScrolled, setBodyScrolled] = useState(false);
  const [deleting, guard] = useSubmitGuard();

  const form = useAppForm({
    defaultValues: { confirmation: "" },
    onSubmitInvalid: () => scheduleFocusInvalidField(formRef.current, "confirmation"),
    onSubmit: async ({ value }) => {
      const trimmed = value.confirmation.trim();
      if (trimmed !== agentName || deleting) return;
      setError("");
      await guard(async () => {
        try {
          await onDelete(trimmed);
        } catch (cause) {
          setError(
            isAppErrorCode(cause, "ACCESS_DENIED")
              ? m.agent_delete_access_denied()
              : isAppError(cause) && cause.errorId === "agent-delete-protected"
                ? m.agent_delete_protected()
                : m.agent_delete_error(),
          );
        }
      });
    },
  });

  return (
    <ModalOverlay
      confirmation
      isOpen={open}
      onOpenChange={(nextOpen: boolean) => {
        if (deleting) return;
        if (!nextOpen) form.reset();
        setError("");
        onOpenChange(nextOpen);
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-lg">
        <Dialog className="flex flex-col text-left" data-agent-delete-dialog>
          {({ close }) => (
            <form.AppForm>
              <form
                ref={formRef}
                className="contents"
                onSubmit={(event) => {
                  event.preventDefault();
                  void form.handleSubmit();
                }}
              >
                <div className="flex shrink-0 items-start justify-between gap-4 px-6 pt-6">
                  <Heading
                    slot="title"
                    className="min-w-0 text-xl font-semibold text-primary wrap-anywhere sm:text-display-xs"
                  >
                    {m.agent_delete_dialog_title()}
                  </Heading>
                  <ButtonUtility
                    data-dialog-close
                    aria-label={m.controls_close()}
                    icon={X}
                    size="sm"
                    color="tertiary"
                    isDisabled={deleting}
                    onClick={close}
                  />
                </div>
                <div
                  className={`mt-4 min-h-0 flex-1 overflow-y-auto border-t pb-2 ${bodyScrolled ? "border-secondary" : "border-transparent"}`}
                  onScroll={(event) => setBodyScrolled(event.currentTarget.scrollTop > 0)}
                  data-dialog-body
                >
                  <Text slot="description" className="block px-6 text-sm text-secondary">
                    {m.agent_delete_dialog_description()}
                  </Text>
                  <label className="grid gap-1 px-6 pt-5 text-sm font-medium text-secondary wrap-anywhere">
                    <EmphasizedName
                      text={m.agent_delete_confirm({ name: agentName })}
                      name={agentName}
                    />
                    <form.AppField name="confirmation">
                      {(field) => (
                        <field.Input
                          size={controlSize}
                          autoFocus
                          placeholder={m.agent_delete_placeholder()}
                          isDisabled={deleting}
                          aria-label={m.agent_delete_confirm({ name: agentName })}
                        />
                      )}
                    </form.AppField>
                  </label>
                  <form.Alert error={error} className="px-6 pt-4 text-sm text-error-primary" />
                </div>
                <DialogActions className="shrink-0 px-6 pt-4 pb-6">
                  <DialogCancel isDisabled={deleting} onPress={close}>
                    {m.controls_cancel()}
                  </DialogCancel>
                  <form.Subscribe
                    selector={(state) => state.values.confirmation.trim() === agentName}
                  >
                    {(confirmed) => (
                      <DialogAction
                        color="secondary-destructive"
                        data-agent-delete-confirm
                        isDisabled={!confirmed || deleting}
                        isLoading={deleting}
                        showTextWhileLoading
                        type="submit"
                      >
                        {deleting ? m.agent_delete_pending() : m.agent_delete_submit()}
                      </DialogAction>
                    )}
                  </form.Subscribe>
                </DialogActions>
              </form>
            </form.AppForm>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function EmphasizedName({ text, name }: { text: string; name: string }) {
  const at = text.indexOf(name);
  if (at < 0) return text;
  return (
    <span>
      {text.slice(0, at)}
      <strong className="font-semibold text-primary">{name}</strong>
      {text.slice(at + name.length)}
    </span>
  );
}
