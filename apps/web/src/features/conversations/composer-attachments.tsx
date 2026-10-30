import { useEffect, useRef, useState } from "react";
import { Download01, Trash01, XClose } from "@untitledui/icons";
import { Popover as AriaPopover } from "react-aria-components";

import { getReadableFileSize } from "#src/components/application/file-upload/file-upload-base";
import { Dialog } from "#src/components/application/modals/modal";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import {
  ProgressBar,
  ProgressBarBase,
} from "#src/components/base/progress-indicators/progress-indicators";
import { FileTypeIcon } from "#src/features/files/file-type-icon";
import { fileTypeLabel } from "#src/features/files/file-meta";
import { cx } from "#src/utils/cx";
import { ATTACHMENT_MAX_BYTES } from "@lrm/coforge-sdk/internal";
import {
  MAX_ATTACHMENTS,
  refusedUploadFailure,
  retryableUploadFailure,
  stillUploading,
  UploadRefused,
  type UploadFailure,
} from "./upload-failure";
import { m } from "#src/paraglide/messages";
import { LoadingImage } from "./loading-image";

export type PendingAttachment = {
  /** Stable key across renders and across the file's own upload lifecycle; independent of
   * `file` identity so two same-named files can coexist. */
  localId: string;
  file: File;
  /** Set once the server has accepted the upload. */
  id?: string;
  /** 0 to 100 while uploading. */
  progress: number;
  /** Why it did not upload; absent while it uploads or once it has. */
  failure?: UploadFailure;
};

/** The short word a tile says for a failure, as Raft's "Too large". */
export function uploadFailureLabel(failure: UploadFailure): string {
  switch (failure) {
    case "empty":
      return m.conversation_attachment_empty();
    case "too_large":
      return m.conversation_attachment_too_large();
    case "too_many":
      return m.conversation_attachment_too_many();
    case "signed_out":
      return m.conversation_attachment_signed_out();
    case "forbidden":
      return m.conversation_attachment_forbidden();
    case "offline":
      return m.conversation_attachment_offline();
    case "failed":
      return m.conversation_attachment_failed();
  }
}

/** The sentence behind the short word: why, and what to do about it. */
export function uploadFailureDetail(failure: UploadFailure, file: Pick<File, "size">): string {
  switch (failure) {
    case "empty":
      return m.conversation_attachment_empty_detail();
    case "too_large":
      // A file under the limit was refused by the server, or a proxy in front of it (a 413).
      return file.size > ATTACHMENT_MAX_BYTES
        ? m.conversation_attachment_too_large_detail({
            size: getReadableFileSize(file.size),
            limit: getReadableFileSize(ATTACHMENT_MAX_BYTES),
          })
        : m.conversation_attachment_too_large_refused();
    case "too_many":
      return m.conversation_attachment_too_many_detail({ max: MAX_ATTACHMENTS });
    case "signed_out":
      return m.conversation_attachment_signed_out_detail();
    case "forbidden":
      return m.conversation_attachment_forbidden_detail();
    case "offline":
      return m.conversation_attachment_offline_detail();
    case "failed":
      return m.conversation_attachment_failed_detail();
  }
}

/** Upload a composer attachment, reporting progress, and resolve with its id. Aborting `signal`
 * cancels the request and rejects with an `AbortError`. */
export function uploadAttachment(
  conversationId: string,
  file: File,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
) {
  return new Promise<string>((resolve, reject) => {
    const form = new FormData();
    form.set("conversationId", conversationId);
    form.set("file", file);
    const request = new XMLHttpRequest();
    request.open("POST", "/api/attachments");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        try {
          resolve((JSON.parse(request.responseText) as { id: string }).id);
        } catch (cause) {
          reject(cause);
        }
      } else reject(new UploadRefused(refusedUploadFailure(request.status)));
    };
    request.onerror = () => reject(new UploadRefused("offline"));
    // Settled on the signal itself: a request aborted before it went out fires no abort event.
    signal?.addEventListener(
      "abort",
      () => {
        request.abort();
        reject(new DOMException("upload aborted", "AbortError"));
      },
      { once: true },
    );
    request.send(form);
  });
}

/**
 * One chosen file in the tray under the text, as Slack shows them: an image is a 4rem thumbnail,
 * any other file a card with its type icon, name and size, so a chosen file is visible at a glance.
 * While it uploads it is dimmed with a progress bar along its foot. A file that failed is drawn as
 * Raft's composer draws it: ringed red and faded, one short word across it ("Too large"), the
 * reason on hover, and a retry right on the tile when one may help. Every tile has a remove button
 * at its corner; clicking the tile opens the preview with the file's details and download.
 */
export function AttachmentTile({
  attachment,
  onRemove,
  onRetry,
}: {
  attachment: PendingAttachment;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const { file, failure } = attachment;
  const uploading = stillUploading(attachment);
  const isImage = file.type.startsWith("image/");
  const [previewUrl, setPreviewUrl] = useState<string>();
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const typeLabel = fileTypeLabel(file.name, file.type);
  const typeAndSize = `${typeLabel ? `${typeLabel} · ` : ""}${getReadableFileSize(file.size)}`;
  const failureLabel = failure && uploadFailureLabel(failure);
  const failureDetail = failure && uploadFailureDetail(failure, file);
  const status = uploading
    ? m.conversation_attachment_uploading({ progress: attachment.progress })
    : typeAndSize;
  // The preview is anchored to the tile and opened by it directly: a dialog trigger between the
  // tooltip and the tile would take the tooltip's hover from it.
  const tileRef = useRef<HTMLLIElement>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  return (
    <li ref={tileRef} className="relative">
      <Tooltip title={failureDetail} isDisabled={!failure || previewOpen} placement="top start">
        <Button
          onPress={() => setPreviewOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={previewOpen}
          color="tertiary"
          size="sm"
          noTextPadding
          aria-label={`${file.name} · ${failure ? `${failureLabel}. ${failureDetail}` : status}`}
          className={cx(
            "overflow-hidden rounded-lg border border-primary bg-primary p-0 shadow-xs hover:bg-primary_hover",
            isImage ? "size-16" : "h-16 w-[13rem] justify-start px-3",
            failure && "border-error",
          )}
        >
          <span className={cx("contents", failure && "*:opacity-20")}>
            {isImage ? (
              previewUrl ? (
                <LoadingImage
                  src={previewUrl}
                  alt=""
                  className="size-full"
                  imgClassName={cx("size-full object-cover", uploading && "opacity-60")}
                  failed={
                    <FileTypeIcon fileName={file.name} contentType={file.type} className="size-8" />
                  }
                />
              ) : (
                <span className="flex size-full items-center justify-center bg-secondary">
                  <FileTypeIcon fileName={file.name} contentType={file.type} className="size-8" />
                </span>
              )
            ) : (
              <span className="flex min-w-0 items-center gap-2.5 text-left">
                <span className="flex size-9 shrink-0 items-center justify-center">
                  <FileTypeIcon fileName={file.name} contentType={file.type} className="size-9" />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium text-secondary">{file.name}</span>
                  <span className="truncate text-xs text-tertiary">{status}</span>
                </span>
              </span>
            )}
          </span>
        </Button>
      </Tooltip>
      <AriaPopover
        triggerRef={tileRef}
        isOpen={previewOpen}
        onOpenChange={setPreviewOpen}
        placement="top start"
        offset={8}
        className="w-[min(24rem,calc(100vw-2rem))] rounded-xl bg-primary shadow-lg ring-1 ring-secondary_alt outline-none"
      >
        <Dialog className="flex flex-col outline-none">
          {({ close }) => (
            <>
              {isImage && previewUrl && (
                <div className="flex justify-center rounded-t-xl bg-secondary p-3">
                  <LoadingImage
                    src={previewUrl}
                    alt=""
                    className="min-h-24 min-w-24 rounded-md"
                    imgClassName="max-h-56 max-w-full rounded-md object-contain"
                  />
                </div>
              )}
              <div className="flex items-center gap-3 p-3">
                {!isImage && (
                  <span className="flex size-10 shrink-0 items-center justify-center">
                    <FileTypeIcon
                      fileName={file.name}
                      contentType={file.type}
                      className="size-10"
                    />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-primary">{file.name}</p>
                  <p className="truncate text-sm text-tertiary">
                    {uploading
                      ? `${attachment.progress}% · ${getReadableFileSize(file.size)}`
                      : typeAndSize}
                  </p>
                  {uploading && <ProgressBar value={attachment.progress} className="mt-1.5" />}
                  {failureDetail && (
                    <p className="mt-0.5 text-sm text-error-primary">{failureDetail}</p>
                  )}
                </div>
                <ButtonUtility
                  icon={Download01}
                  size="sm"
                  color="tertiary"
                  tooltip={m.conversation_attachment_download()}
                  href={previewUrl}
                  download={file.name}
                />
                <ButtonUtility
                  icon={Trash01}
                  size="sm"
                  color="tertiary"
                  tooltip={m.conversation_attachment_remove()}
                  onClick={() => {
                    close();
                    onRemove();
                  }}
                />
              </div>
            </>
          )}
        </Dialog>
      </AriaPopover>
      {uploading && (
        <ProgressBarBase
          value={attachment.progress}
          className="pointer-events-none absolute inset-x-2 bottom-1.5 h-1 w-auto"
        />
      )}
      {failure && (
        // Across the faded tile, not inside its button, so the retry is a button of its own.
        <span className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-0.5 text-center">
          <span className="text-xs font-semibold text-error-primary">{failureLabel}</span>
          {retryableUploadFailure(failure) && (
            <Button
              color="link-color"
              size="sm"
              className="pointer-events-auto text-xs"
              onPress={onRetry}
              aria-label={`${m.controls_retry()} · ${file.name}`}
            >
              {m.controls_retry()}
            </Button>
          )}
        </span>
      )}
      <ButtonUtility
        icon={XClose}
        size="xs"
        color="secondary"
        tooltip={m.conversation_attachment_remove_named({ name: file.name })}
        onClick={onRemove}
        className="absolute -top-2 -right-2 rounded-full bg-primary p-0.5 shadow-xs ring-1 ring-primary"
      />
    </li>
  );
}
