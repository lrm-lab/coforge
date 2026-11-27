import { useRef, useState } from "react";
import { useStore } from "@tanstack/react-form";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { setFieldServerError, useAppForm } from "#src/components/ui/form";
import {
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from "#src/components/ui/unsaved-changes-dialog";
import { scheduleFocusInvalidField } from "#src/lib/form-field-error";
import { m } from "#src/paraglide/messages";
import { chatSectionFields, type ChatSection } from "./chat-section.schemas";
import { useSidebarActions } from "./sidebar-lists";
import { ChatSectionEmojiPicker, DEFAULT_SECTION_EMOJI } from "./chat-section-emoji-picker";
import {
  DialogAction,
  DialogActions,
  DialogCancel,
  useDialogControlSize,
} from "#src/components/ui/dialog-actions";

export function ChatSectionDialog({
  section,
  onClose,
  onCreated,
}: {
  section?: ChatSection;
  onClose: () => void;
  onCreated?: (section: ChatSection) => void;
}) {
  const controlSize = useDialogControlSize();
  const initialName = section?.name ?? "";
  const initialEmoji = section ? section.emoji : DEFAULT_SECTION_EMOJI;
  const [error, setError] = useState("");
  const busy = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const actions = useSidebarActions();

  const form = useAppForm({
    defaultValues: {
      name: initialName,
      emoji: initialEmoji as string | null,
    },
    onSubmitInvalid: () => scheduleFocusInvalidField(formRef.current),
    onSubmit: async ({ value }) => {
      if (busy.current) return;
      const parsed = chatSectionFields.safeParse(value);
      if (!parsed.success) {
        setFieldServerError(form, "name", m.chat_section_name_required(), formRef.current);
        return;
      }
      busy.current = true;
      setError("");
      try {
        if (section) await actions.updateSection(section.id, parsed.data);
        else {
          const created = await actions.createSection(parsed.data);
          onCreated?.(created);
        }
        onClose();
      } catch {
        setError(m.chat_section_save_error());
      } finally {
        busy.current = false;
      }
    },
  });

  const { name, emoji, saving } = useStore(form.store, (state) => ({
    name: state.values.name,
    emoji: state.values.emoji,
    saving: state.isSubmitting,
  }));
  const parsed = chatSectionFields.safeParse({ name, emoji });
  const dirty = name !== initialName || emoji !== initialEmoji;
  const guard = useUnsavedChangesGuard({ overlayOpen: true, dirty, close: onClose });

  return (
    <>
      <ModalOverlay
        isOpen
        onOpenChange={(open) => {
          if (!open && !busy.current) guard.requestClose();
        }}
      >
        <Modal className="w-[calc(100vw-2rem)] max-w-md">
          <Dialog>
            <DialogHeader
              title={section ? m.chat_section_edit() : m.chat_section_create()}
              onClose={saving ? undefined : guard.requestClose}
            />
            <form.AppForm>
              <form
                ref={formRef}
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  void form.handleSubmit();
                }}
                className="flex flex-col gap-4 p-6 pt-5"
              >
                <div className="flex items-start gap-3">
                  <form.AppField name="emoji">
                    {(field) => (
                      <ChatSectionEmojiPicker
                        value={field.state.value}
                        onChange={(next) => {
                          field.handleChange(next);
                          setError("");
                        }}
                        isDisabled={saving}
                      />
                    )}
                  </form.AppField>
                  <form.AppField
                    name="name"
                    validators={{
                      onChange: ({ value }) =>
                        value.length > 0 && value.trim().length === 0
                          ? m.chat_section_name_required()
                          : undefined,
                      onSubmit: ({ value }) =>
                        value.trim().length === 0 ? m.chat_section_name_required() : undefined,
                    }}
                  >
                    {(field) => (
                      <field.Input
                        size={controlSize}
                        label={m.chat_section_name()}
                        maxLength={18}
                        isRequired
                        autoFocus
                        isDisabled={saving}
                        className="min-w-0 flex-1"
                        onChange={() => setError("")}
                      />
                    )}
                  </form.AppField>
                </div>
                <form.Alert error={error} />
                <DialogActions>
                  <DialogCancel onPress={guard.requestClose} isDisabled={saving}>
                    {m.controls_cancel()}
                  </DialogCancel>
                  <DialogAction
                    color="primary"
                    type="submit"
                    isDisabled={saving || !parsed.success}
                    isLoading={saving}
                    showTextWhileLoading
                  >
                    {section ? m.chat_section_save() : m.chat_section_create_button()}
                  </DialogAction>
                </DialogActions>
              </form>
            </form.AppForm>
          </Dialog>
        </Modal>
      </ModalOverlay>
      <UnsavedChangesDialog {...guard.promptProps} />
    </>
  );
}
