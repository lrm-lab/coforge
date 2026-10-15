import { useRef, useState, type FormEvent } from "react";
import { Heading, Text } from "react-aria-components";
import { Trash01, XClose } from "@untitledui/icons";
import { Dialog, Modal, ModalOverlay } from "#src/components/application/modals/modal";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Input } from "#src/components/base/input/input";
import { FeaturedIcon } from "#src/components/foundations/featured-icon/featured-icon";
import { m } from "#src/paraglide/messages";
import { chatSectionFields, type ChatSection } from "./chat-section.schemas";
import { useSidebarActions } from "./sidebar-lists";

/** Mounted for each create/edit, preserving input after an unsuccessful save. */
export function ChatSectionDialog({
  section,
  deleting = false,
  onClose,
}: {
  section?: ChatSection;
  deleting?: boolean;
  onClose: () => void;
}) {
  const [name, setName] = useState(section?.name ?? "");
  const [emoji, setEmoji] = useState(section?.emoji ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const actions = useSidebarActions();
  const parsed = chatSectionFields.safeParse({ name, emoji: emoji.trim() || null });
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current || (!deleting && !parsed.success)) return;
    busy.current = true;
    setSaving(true);
    setError("");
    try {
      if (section && deleting) await actions.removeSection(section.id);
      else if (parsed.success) {
        if (section) await actions.updateSection(section.id, parsed.data);
        else await actions.createSection(parsed.data);
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
    <ModalOverlay
      isOpen
      onOpenChange={(open) => {
        if (!open && !busy.current) onClose();
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-md">
        <Dialog className="p-6">
          <ButtonUtility
            icon={XClose}
            size="sm"
            color="tertiary"
            aria-label={m.controls_close()}
            onClick={onClose}
            isDisabled={saving}
            className="absolute top-4 right-4"
          />
          <Heading slot="title" className="pr-8 text-lg font-semibold text-primary">
            {deleting
              ? m.chat_section_delete()
              : section
                ? m.chat_section_edit()
                : m.chat_section_create()}
          </Heading>
          <form onSubmit={(event) => void submit(event)} className="mt-5 flex flex-col gap-4">
            {deleting && section ? (
              <div className="flex items-start gap-3">
                <FeaturedIcon color="error" theme="light" size="sm" icon={Trash01} />
                <Text slot="description" className="text-sm text-secondary">
                  {m.chat_section_delete_description({ name: section.name })}
                </Text>
              </div>
            ) : (
              <div className="flex items-start gap-3">
                <Input
                  label={m.chat_section_emoji()}
                  isRequired={false}
                  hideRequiredIndicator
                  value={emoji}
                  onChange={setEmoji}
                  maxLength={16}
                  placeholder="📁"
                  isDisabled={saving}
                  className="w-24 shrink-0"
                  isInvalid={
                    emoji.length > 0 &&
                    !chatSectionFields.shape.emoji.safeParse(emoji.trim()).success
                  }
                />
                <Input
                  label={m.chat_section_name()}
                  value={name}
                  onChange={setName}
                  maxLength={18}
                  isRequired
                  autoFocus
                  isDisabled={saving}
                  className="min-w-0 flex-1"
                />
              </div>
            )}
            {error && (
              <p role="alert" className="text-sm text-error-primary">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-3">
              <Button color="secondary" size="sm" onPress={onClose} isDisabled={saving}>
                {m.controls_cancel()}
              </Button>
              <Button
                color={deleting ? "primary-destructive" : "primary"}
                size="sm"
                type="submit"
                isDisabled={saving || (!deleting && !parsed.success)}
                isLoading={saving}
                showTextWhileLoading
              >
                {deleting
                  ? m.chat_section_delete()
                  : section
                    ? m.chat_section_save()
                    : m.chat_section_create_button()}
              </Button>
            </div>
          </form>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
