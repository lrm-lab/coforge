import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Upload01, XClose as X } from "@untitledui/icons";
import { Heading, RadioGroup } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { DialogAction, DialogActions, DialogCancel } from "#src/components/ui/dialog-actions";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { AvatarChoice } from "#src/features/avatars/avatar-choice";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { m } from "#src/paraglide/messages";

import { avatarPresets } from "./avatar-presets";

/**
 * A person's avatar picker, opened by clicking their picture on Settings → Account, as an Agent's
 * creator picks its mascot: the platform's ten pictures, the current one selected. Upload adds a
 * picture of their own beside the button, selected, to choose like the others. Nothing is written
 * until Save. Picking a platform picture again is how an uploaded one goes.
 */
/** The radio value of the picture the person has just uploaded. */
const UPLOADED = "uploaded";

export function PersonAvatarDialog({
  currentAvatarUrl,
  open,
  onOpenChange,
  onSave,
  onUpload,
}: {
  currentAvatarUrl: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Stores the chosen platform picture; rejects when it cannot. */
  onSave: (presetId: string) => Promise<void>;
  /** Uploads a picture of the person's own; rejects when it cannot. */
  onUpload: (file: File) => Promise<void>;
}) {
  const currentId = avatarPresets.find((preset) => preset.url === currentAvatarUrl)?.id ?? null;
  const [picked, setPicked] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, guard] = useSubmitGuard();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  // The chosen file as a picture to show until Save; the URL is revoked when it goes.
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const selected = picked ?? currentId;

  function reset() {
    setPicked(null);
    setFile(null);
    setFailed(false);
  }

  function run(action: () => Promise<void>) {
    setFailed(false);
    void guard(async () => {
      try {
        await action();
        reset();
        onOpenChange(false);
      } catch {
        setFailed(true);
      }
    });
  }

  function choose(event: ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0];
    event.target.value = "";
    if (!chosen) return;
    setFile(chosen);
    setPicked(UPLOADED);
  }

  function save() {
    if (selected === UPLOADED) {
      if (file) run(() => onUpload(file));
    } else if (selected) {
      run(() => onSave(selected));
    }
  }

  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={(nextOpen: boolean) => {
        if (busy) return;
        if (!nextOpen) reset();
        onOpenChange(nextOpen);
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-md">
        <Dialog className="text-left" data-person-avatar-dialog>
          {({ close }) => (
            <>
              <div className="flex shrink-0 items-start justify-between gap-4 px-6 pt-6">
                <Heading slot="title" className="min-w-0 text-xl font-semibold text-primary">
                  {m.settings_avatar_dialog_title()}
                </Heading>
                <ButtonUtility
                  aria-label={m.controls_close()}
                  icon={X}
                  size="sm"
                  color="tertiary"
                  isDisabled={busy}
                  onClick={close}
                />
              </div>
              {/* One group for the platform pictures and an uploaded one, so either is chosen the
                  same way and Save writes whichever is selected. */}
              <RadioGroup
                aria-label={m.settings_avatar_dialog_title()}
                value={selected}
                onChange={setPicked}
                isDisabled={busy}
                orientation="horizontal"
              >
                <div className="mt-5 grid grid-cols-5 gap-4 px-6">
                  {avatarPresets.map((preset) => (
                    <AvatarChoice
                      key={preset.id}
                      value={preset.id}
                      src={preset.url}
                      label={m.settings_avatar_preset_label({ number: preset.number })}
                      hideLabel
                    />
                  ))}
                </div>
                {failed && (
                  <p role="alert" className="px-6 pt-4 text-sm text-error-primary">
                    {m.settings_avatar_dialog_error()}
                  </p>
                )}
                <DialogActions className="mt-6 shrink-0 justify-between px-6 pb-6">
                  <div className="flex items-center gap-3">
                    {preview && (
                      <div className="size-10 shrink-0">
                        <AvatarChoice
                          value={UPLOADED}
                          src={preview}
                          label={m.settings_avatar_uploaded()}
                          hideLabel
                        />
                      </div>
                    )}
                    <Button
                      type="button"
                      color="link-gray"
                      size="sm"
                      iconLeading={Upload01}
                      isDisabled={busy}
                      onPress={() => fileInput.current?.click()}
                    >
                      {m.settings_avatar_change()}
                    </Button>
                    <input
                      ref={fileInput}
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      aria-label={m.settings_avatar_change()}
                      disabled={busy}
                      className="sr-only"
                      onChange={choose}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <DialogCancel isDisabled={busy} onPress={close}>
                      {m.controls_cancel()}
                    </DialogCancel>
                    <DialogAction
                      isDisabled={selected === null || selected === currentId || busy}
                      isLoading={busy}
                      showTextWhileLoading
                      onPress={save}
                    >
                      {m.settings_profile_save()}
                    </DialogAction>
                  </div>
                </DialogActions>
              </RadioGroup>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
