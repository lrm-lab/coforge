import { useRef, useState, type FormEvent } from "react";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { Input } from "#src/components/base/input/input";
import {
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from "#src/components/ui/unsaved-changes-dialog";
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
  const [name, setName] = useState(initialName);
  const [emoji, setEmoji] = useState<string | null>(initialEmoji);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const actions = useSidebarActions();
  const parsed = chatSectionFields.safeParse({ name, emoji });
  const blankName = name.length > 0 && name.trim().length === 0;
  const dirty = name !== initialName || emoji !== initialEmoji;
  const guard = useUnsavedChangesGuard({ overlayOpen: true, dirty, close: onClose });
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current || !parsed.success) return;
    busy.current = true;
    setSaving(true);
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
      setSaving(false);
    }
  }
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
            <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4 p-6 pt-5">
              <div className="flex items-start gap-3">
                <ChatSectionEmojiPicker value={emoji} onChange={setEmoji} isDisabled={saving} />
                <Input
                  size={controlSize}
                  label={m.chat_section_name()}
                  value={name}
                  onChange={setName}
                  maxLength={18}
                  isRequired
                  isInvalid={blankName}
                  hint={blankName ? m.chat_section_name_required() : undefined}
                  autoFocus
                  isDisabled={saving}
                  className="min-w-0 flex-1"
                />
              </div>
              {error && (
                <p role="alert" className="text-sm text-error-primary">
                  {error}
                </p>
              )}
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
          </Dialog>
        </Modal>
      </ModalOverlay>
      <UnsavedChangesDialog {...guard.promptProps} />
    </>
  );
}
