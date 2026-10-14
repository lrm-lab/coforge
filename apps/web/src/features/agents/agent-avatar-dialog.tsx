import { useEffect, useState } from "react";
import { Upload01, XClose as X } from "@untitledui/icons";
import { Heading, Radio, RadioGroup } from "react-aria-components";

import { Dialog, Modal, ModalOverlay } from "#src/components/application/modals/modal";
import { Avatar } from "#src/components/base/avatar/avatar";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import { agentAvatarPictures } from "./avatar-pictures/pictures";

/**
 * The creator's change-avatar dialog, opened by clicking the Agent's picture in its profile: the
 * platform's pictures and an upload tile beside a live preview of the one chosen. Nothing is
 * written until Save; Cancel and Escape drop the choice. Removing the picture is its own action
 * and applies at once.
 */
export function AgentAvatarDialog({
  name,
  avatarUrl,
  open,
  onOpenChange,
  onUpload,
  onChoosePicture,
  onRemove,
}: {
  name: string;
  avatarUrl: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpload: (file: File) => Promise<void>;
  onChoosePicture: (pictureId: string) => Promise<void>;
  /** Present only while the Agent has a picture to remove. */
  onRemove?: () => Promise<void>;
}) {
  const [pictureId, setPictureId] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, guard] = useSubmitGuard();

  // The preview of an uploaded file is an object URL, which must be revoked to free the blob.
  useEffect(() => {
    if (!file) {
      setFilePreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setFilePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const chosenPicture = agentAvatarPictures.find((picture) => picture.id === pictureId);
  const previewUrl = filePreview ?? chosenPicture?.url ?? avatarUrl;
  const canSave = Boolean(file || pictureId);

  function reset() {
    setPictureId(null);
    setFile(null);
    setFailed(false);
  }

  function run(task: () => Promise<void>) {
    setFailed(false);
    void guard(async () => {
      try {
        await task();
        reset();
        onOpenChange(false);
      } catch {
        setFailed(true);
      }
    });
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
      <Modal className="w-[calc(100vw-2rem)] max-w-xl">
        <Dialog className="overflow-hidden text-left" data-agent-avatar-dialog>
          {({ close }) => (
            <>
              <div className="flex shrink-0 items-start justify-between gap-4 px-6 pt-6">
                <Heading slot="title" className="min-w-0 text-xl font-semibold text-primary">
                  {m.agent_avatar_dialog_title()}
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
              <div className="mt-5 flex flex-col gap-6 px-6 sm:flex-row">
                <div className="flex shrink-0 flex-col items-center gap-2 sm:w-32">
                  {previewUrl ? (
                    <img src={previewUrl} alt="" className="size-28 rounded-2xl object-cover" />
                  ) : (
                    <Avatar
                      size="2xl"
                      className="size-28"
                      alt={name}
                      initials={avatarInitial(name)}
                      contentClassName={avatarToneClassName(name)}
                    />
                  )}
                  <p className="max-w-full truncate text-sm font-medium text-primary">{name}</p>
                </div>
                <div className="min-w-0 flex-1">
                  <RadioGroup
                    aria-label={m.agent_avatar_dialog_title()}
                    value={pictureId}
                    onChange={(id) => {
                      setFile(null);
                      setPictureId(id);
                    }}
                    isDisabled={busy}
                    orientation="horizontal"
                    className="grid grid-cols-5 gap-2 sm:grid-cols-6"
                  >
                    <label
                      className={cx(
                        "flex aspect-square cursor-pointer items-center justify-center rounded-xl border border-dashed border-secondary text-tertiary transition-colors hover:bg-secondary has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-focus-ring",
                        file &&
                          "border-solid bg-brand-primary text-brand-secondary ring-2 ring-focus-ring",
                        busy && "pointer-events-none opacity-50",
                      )}
                    >
                      <Upload01 className="size-5" />
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        aria-label={m.agent_avatar_upload()}
                        disabled={busy}
                        className="sr-only"
                        onChange={(event) => {
                          const picked = event.currentTarget.files?.[0];
                          event.currentTarget.value = "";
                          if (!picked) return;
                          setPictureId(null);
                          setFile(picked);
                        }}
                      />
                    </label>
                    {agentAvatarPictures.map((picture, index) => (
                      <Radio
                        key={picture.id}
                        value={picture.id}
                        aria-label={m.agent_avatar_picture_label({ number: index + 1 })}
                        className="group cursor-pointer outline-hidden"
                      >
                        {({ isSelected, isFocusVisible }) => (
                          <span
                            className={cx(
                              "block rounded-xl p-0.5 transition-colors",
                              isSelected
                                ? "bg-brand-primary ring-2 ring-focus-ring"
                                : "group-hover:bg-secondary",
                              isFocusVisible && "outline-2 outline-offset-2 outline-focus-ring",
                            )}
                          >
                            <img
                              src={picture.url}
                              alt=""
                              loading="lazy"
                              className="aspect-square w-full rounded-[0.625rem] object-cover"
                            />
                          </span>
                        )}
                      </Radio>
                    ))}
                  </RadioGroup>
                  <p className="mt-3 text-xs text-tertiary">{m.agent_avatar_help()}</p>
                </div>
              </div>
              {failed && (
                <p role="alert" className="px-6 pt-4 text-sm text-error-primary">
                  {m.agent_avatar_save_error()}
                </p>
              )}
              <div className="mt-6 flex shrink-0 flex-wrap items-center gap-3 border-t border-secondary px-6 py-4">
                {onRemove && (
                  <Button
                    color="tertiary"
                    size="sm"
                    isDisabled={busy}
                    onPress={() => run(onRemove)}
                  >
                    {m.agent_avatar_remove()}
                  </Button>
                )}
                <div className="ml-auto flex gap-3">
                  <Button color="secondary" isDisabled={busy} onPress={close}>
                    {m.controls_cancel()}
                  </Button>
                  <Button
                    isDisabled={!canSave || busy}
                    isLoading={busy}
                    showTextWhileLoading
                    onPress={() => run(() => (file ? onUpload(file) : onChoosePicture(pictureId!)))}
                  >
                    {m.agent_avatar_save()}
                  </Button>
                </div>
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
