import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FC } from "react";
import { useRouterState } from "@tanstack/react-router";
import {
  AlertCircle,
  ImagePlus,
  Lightbulb02,
  MessageTextSquare01,
  XClose,
} from "@untitledui/icons";
import {
  Button as AriaButton,
  Heading,
  Radio as AriaRadio,
  RadioGroup as AriaRadioGroup,
  TextField as AriaTextField,
} from "react-aria-components";

import { CloseButton } from "#src/components/base/buttons/close-button";
import { TextAreaBase } from "#src/components/base/textarea/textarea";
import { Alert } from "#src/components/ui/alert";
import {
  DialogAction,
  DialogActions,
  DialogCancel,
  useDialogControlSize,
} from "#src/components/ui/dialog-actions";
import { submitOnModEnter } from "#src/components/ui/dialog-form-keys";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { useAppToast } from "#src/components/ui/toast";
import {
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from "#src/components/ui/unsaved-changes-dialog";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import { detectClientInfo, isAcceptedFeedbackImage, submitFeedbackForm } from "./feedback-client";
import {
  FEEDBACK_ATTACHMENT_TYPES,
  FEEDBACK_BODY_MAX_LENGTH,
  FEEDBACK_MAX_ATTACHMENTS,
  type FeedbackCategory,
} from "./feedback-types";

type DraftAttachment = {
  id: string;
  file: File;
  previewUrl: string;
};

const CATEGORY_OPTIONS: readonly {
  id: FeedbackCategory;
  label: () => string;
  placeholder: () => string;
  icon: FC<{ className?: string }>;
}[] = [
  {
    id: "bug",
    label: m.feedback_category_bug,
    placeholder: m.feedback_placeholder_bug,
    icon: AlertCircle,
  },
  {
    id: "idea",
    label: m.feedback_category_idea,
    placeholder: m.feedback_placeholder_idea,
    icon: Lightbulb02,
  },
  {
    id: "other",
    label: m.feedback_category_other,
    placeholder: m.feedback_placeholder_other,
    icon: MessageTextSquare01,
  },
];

export function FeedbackDialog({
  open,
  onOpenChange,
  workspaceId,
  workspaceName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  workspaceName: string;
}) {
  const controlSize = useDialogControlSize();
  const toast = useAppToast();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState<FeedbackCategory>("bug");
  const [body, setBody] = useState("");
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const [showContext, setShowContext] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState("");
  const [pending, guard] = useSubmitGuard();
  const [clientInfo] = useState(() => detectClientInfo());

  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  useEffect(() => {
    return () => {
      for (const item of attachmentsRef.current) URL.revokeObjectURL(item.previewUrl);
    };
  }, []);

  function resetDraft() {
    for (const item of attachmentsRef.current) URL.revokeObjectURL(item.previewUrl);
    setCategory("bug");
    setBody("");
    setAttachments([]);
    setShowContext(false);
    setDragOver(false);
    setError("");
  }

  const dirty = body.trim().length > 0 || attachments.length > 0;
  const unsaved = useUnsavedChangesGuard({
    overlayOpen: open,
    dirty,
    close: () => onOpenChange(false),
    onDiscard: resetDraft,
  });

  const activeCategory =
    CATEGORY_OPTIONS.find((option) => option.id === category) ?? CATEGORY_OPTIONS[0]!;

  function addImages(incoming: readonly File[]) {
    if (incoming.length === 0) return;
    const remaining = FEEDBACK_MAX_ATTACHMENTS - attachments.length;
    if (remaining <= 0) {
      setError(m.feedback_error_too_many_files({ max: FEEDBACK_MAX_ATTACHMENTS }));
      return;
    }
    const valid: DraftAttachment[] = [];
    let rejectedInvalid = false;
    let rejectedLimit = false;
    for (const file of incoming) {
      if (!isAcceptedFeedbackImage(file)) {
        rejectedInvalid = true;
        continue;
      }
      if (valid.length >= remaining) {
        rejectedLimit = true;
        break;
      }
      valid.push({
        id: crypto.randomUUID(),
        file,
        previewUrl: URL.createObjectURL(file),
      });
    }
    if (valid.length > 0) {
      setAttachments((current) => [...current, ...valid]);
    }
    if (rejectedInvalid) {
      setError(m.feedback_error_invalid_file());
    } else if (rejectedLimit) {
      setError(m.feedback_error_too_many_files({ max: FEEDBACK_MAX_ATTACHMENTS }));
    } else {
      setError("");
    }
  }

  function removeAttachment(id: string) {
    setAttachments((current) => {
      const target = current.find((item) => item.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return current.filter((item) => item.id !== id);
    });
    setError("");
  }

  function onPaste(event: ClipboardEvent<HTMLDivElement>) {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    addImages(files);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragOver(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) addImages(files);
  }

  return (
    <>
      <ModalOverlay
        isOpen={open}
        isDismissable={!pending}
        onOpenChange={(next) => {
          if (next) onOpenChange(true);
          else if (!pending) unsaved.requestClose();
        }}
      >
        <Modal className="w-[calc(100vw-2rem)] max-w-[31rem]">
          <Dialog className="text-left">
            <form
              className="grid gap-4 p-6"
              onKeyDown={submitOnModEnter}
              onSubmit={(event) => {
                event.preventDefault();
                if (!body.trim()) {
                  setError(m.feedback_error_empty());
                  return;
                }
                void guard(async () => {
                  setError("");
                  try {
                    await submitFeedbackForm({
                      category,
                      body,
                      workspaceId,
                      pagePath: pathname,
                      clientInfo,
                      files: attachments.map((item) => item.file),
                    });
                    resetDraft();
                    onOpenChange(false);
                    toast.success(m.feedback_toast_sent());
                  } catch {
                    setError(m.feedback_error_submit_failed());
                  }
                });
              }}
            >
              <div className="flex items-center justify-between gap-3">
                <Heading slot="title" className="text-lg font-semibold text-primary">
                  {m.feedback_dialog_title()}
                </Heading>
                <CloseButton
                  size="sm"
                  slot={null}
                  isDisabled={pending}
                  onPress={unsaved.requestClose}
                  label={m.feedback_cancel()}
                />
              </div>

              <AriaRadioGroup
                aria-label={m.feedback_category_label()}
                orientation="horizontal"
                value={category}
                isDisabled={pending}
                onChange={(value) => setCategory(value as FeedbackCategory)}
                className="flex flex-wrap gap-2"
              >
                {CATEGORY_OPTIONS.map((option) => {
                  const Icon = option.icon;
                  return (
                    <AriaRadio
                      key={option.id}
                      value={option.id}
                      className={({ isSelected, isFocusVisible }) =>
                        cx(
                          "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-3 text-sm font-medium ring-1 ring-inset transition-colors duration-100 ease-out outline-focus-ring",
                          isSelected
                            ? "bg-selection-bar-primary text-selection-bar-primary-fg ring-transparent"
                            : "bg-primary text-secondary ring-secondary hover:bg-secondary",
                          isFocusVisible && "outline-2 outline-offset-2",
                        )
                      }
                    >
                      <Icon aria-hidden="true" className="size-4 shrink-0" />
                      <span>{option.label()}</span>
                    </AriaRadio>
                  );
                })}
              </AriaRadioGroup>

              <input
                ref={fileInputRef}
                type="file"
                accept={FEEDBACK_ATTACHMENT_TYPES.join(",")}
                multiple
                className="hidden"
                onChange={(event) => {
                  const files = event.target.files ? Array.from(event.target.files) : [];
                  addImages(files);
                  event.target.value = "";
                }}
              />

              <div
                onPaste={onPaste}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
                className={cx(
                  "grid gap-2.5 rounded-xl border bg-secondary p-3 transition-colors duration-100 ease-out focus-within:border-field-border-typing focus-within:bg-primary",
                  dragOver ? "border-brand bg-brand-primary" : "border-secondary",
                )}
              >
                <AriaTextField
                  aria-label={m.feedback_description_label()}
                  value={body}
                  onChange={(next) => {
                    setBody(next);
                    if (error && next.trim()) setError("");
                  }}
                  isDisabled={pending}
                  maxLength={FEEDBACK_BODY_MAX_LENGTH}
                >
                  <TextAreaBase
                    autoFocus
                    rows={4}
                    size={controlSize}
                    placeholder={activeCategory.placeholder()}
                    className="resize-none border-0 bg-transparent p-0 shadow-none ring-0 focus:ring-0"
                  />
                </AriaTextField>

                {attachments.length > 0 && (
                  <ul className="flex flex-wrap gap-2">
                    {attachments.map((item) => (
                      <li
                        key={item.id}
                        className="relative h-14 w-18 overflow-hidden rounded-lg border border-secondary bg-primary"
                      >
                        <img
                          src={item.previewUrl}
                          alt={item.file.name}
                          className="size-full object-cover"
                        />
                        <AriaButton
                          aria-label={m.feedback_remove_screenshot({ name: item.file.name })}
                          isDisabled={pending}
                          onPress={() => removeAttachment(item.id)}
                          className="absolute top-1 right-1 flex size-5 cursor-pointer items-center justify-center rounded-full bg-selection-bar-primary text-selection-bar-primary-fg outline-focus-ring focus-visible:outline-2"
                        >
                          <XClose aria-hidden="true" className="size-3" />
                        </AriaButton>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="flex items-center justify-between gap-2 border-t border-secondary pt-2">
                  <AriaButton
                    isDisabled={pending || attachments.length >= FEEDBACK_MAX_ATTACHMENTS}
                    onPress={() => fileInputRef.current?.click()}
                    className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs font-medium text-tertiary transition-colors duration-100 ease-out outline-focus-ring hover:bg-active hover:text-primary focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <ImagePlus aria-hidden="true" className="size-4 shrink-0" />
                    <span>
                      {m.feedback_add_screenshot({
                        count: attachments.length,
                        max: FEEDBACK_MAX_ATTACHMENTS,
                      })}
                    </span>
                  </AriaButton>
                  <span className="text-xs text-quaternary tabular-nums">
                    {body.length} / {FEEDBACK_BODY_MAX_LENGTH}
                  </span>
                </div>
              </div>

              {error && <Alert color="error" title={error} />}

              <div className="grid gap-2">
                <div className="flex items-center justify-between gap-3 rounded-lg bg-tertiary px-3 py-2 text-xs text-tertiary">
                  <span className="min-w-0">{m.feedback_context_notice()}</span>
                  <AriaButton
                    aria-expanded={showContext}
                    onPress={() => setShowContext((current) => !current)}
                    className="shrink-0 cursor-pointer rounded-xs text-xs font-semibold text-primary underline underline-offset-2 outline-focus-ring focus-visible:outline-2"
                  >
                    {showContext ? m.feedback_context_hide() : m.feedback_context_show()}
                  </AriaButton>
                </div>

                {showContext && (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg border border-secondary bg-secondary px-3 py-2 text-xs">
                    <dt className="text-tertiary">{m.feedback_context_workspace()}</dt>
                    <dd className="truncate font-mono text-primary">{workspaceName}</dd>
                    <dt className="text-tertiary">{m.feedback_context_page()}</dt>
                    <dd className="truncate font-mono text-primary">{pathname}</dd>
                    <dt className="text-tertiary">{m.feedback_context_client()}</dt>
                    <dd className="truncate font-mono text-primary">{clientInfo}</dd>
                  </dl>
                )}
              </div>

              <DialogActions>
                <DialogCancel type="button" isDisabled={pending} onPress={unsaved.requestClose}>
                  {m.feedback_cancel()}
                </DialogCancel>
                <DialogAction
                  type="submit"
                  color="primary"
                  isDisabled={!body.trim()}
                  isLoading={pending}
                  showTextWhileLoading
                >
                  {pending ? m.feedback_submitting() : m.feedback_submit()}
                </DialogAction>
              </DialogActions>
            </form>
          </Dialog>
        </Modal>
      </ModalOverlay>
      <UnsavedChangesDialog
        {...unsaved.promptProps}
        description={m.feedback_discard_description()}
      />
    </>
  );
}
