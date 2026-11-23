import { useEffect, useRef, useState } from "react";
import { Download01, RefreshCcw01, Trash01, XClose } from "@untitledui/icons";
import { FileTrigger, Popover as AriaPopover } from "react-aria-components";

import { Dialog } from "#src/components/application/modals/modal";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import {
  ProgressBar,
  ProgressBarBase,
} from "#src/components/base/progress-indicators/progress-indicators";
import { FileTypeIcon } from "#src/features/files/file-type-icon";
import { fileTypeLabel, formatFileSize } from "#src/features/files/file-meta";
import { isImageType } from "#src/lib/inline-image";
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
  file?: File;
  fileName?: string;
  /** Set once the server has accepted the upload. */
  id?: string;
  /** 0 to 100 while uploading. */
  progress: number;
  /** Why it did not upload; absent while it uploads or once it has. */
  failure?: UploadFailure;
};

export function pendingAttachmentName(item: Pick<PendingAttachment, "file" | "fileName">): string {
  return item.file?.name ?? item.fileName ?? "";
}

/** The short word a tile says for a failure, as Raft's "Too large". */
export function uploadFailureLabel(failure: UploadFailure, hasFile = true): string {
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
    case "expired":
      return hasFile ? m.conversation_attachment_expired() : m.conversation_attachment_reselect();
  }
}

/** The sentence behind the short word: why, and what to do about it. */
export function uploadFailureDetail(failure: UploadFailure, file?: Pick<File, "size">): string {
  switch (failure) {
    case "empty":
      return m.conversation_attachment_empty_detail();
    case "too_large":
      // A file under the limit was refused by the server, or a proxy in front of it (a 413).
      return file && file.size > ATTACHMENT_MAX_BYTES
        ? m.conversation_attachment_too_large_detail({
            size: formatFileSize(file.size),
            limit: formatFileSize(ATTACHMENT_MAX_BYTES),
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
    case "expired":
      return file
        ? m.conversation_attachment_expired_detail()
        : m.conversation_attachment_reselect_detail();
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
 * One chosen file in the row under the text, as Slack's composer shows them: an image is a 3.5rem
 * thumbnail, any other file a compact card with its type icon, name, and type and size, so a chosen
 * file is visible at a glance. While it uploads it is dimmed with a progress bar along its foot. A
 * file that failed is a card ringed red whose second line says why in a word ("Too large"), in
 * place of its type and size, never over them; the reason in full shows on hover and in its
 * preview, and a retry sits on the card when one may help. Every tile has a remove button at its
 * corner; clicking the tile opens the preview with the file's details and download.
 */
export function AttachmentTile({
  attachment,
  onRemove,
  onRetry,
  onReplace,
}: {
  attachment: PendingAttachment;
  onRemove: () => void;
  onRetry: () => void;
  onReplace?: (file: File) => void;
}) {
  const { file, failure } = attachment;
  const name = pendingAttachmentName(attachment);
  const contentType = file?.type ?? "";
  const uploading = stillUploading(attachment);
  const isImage = file ? isImageType(file.type) : false;
  // A failed image is a card too: its thumbnail has no room to say why.
  const thumbnail = isImage && !failure;
  const retryable = Boolean(file) && failure !== undefined && retryableUploadFailure(failure);
  const reselectable = !file && failure === "expired" && Boolean(onReplace);
  const [previewUrl, setPreviewUrl] = useState<string>();
  useEffect(() => {
    if (!file) {
      setPreviewUrl(undefined);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const typeLabel = fileTypeLabel(name, contentType);
  const typeAndSize = file
    ? `${typeLabel ? `${typeLabel} · ` : ""}${formatFileSize(file.size)}`
    : m.conversation_attachment_uploaded();
  const failureLabel = failure && uploadFailureLabel(failure, Boolean(file));
  const failureDetail = failure && uploadFailureDetail(failure, file);
  const status = failureLabel
    ? failureLabel
    : uploading
      ? m.conversation_attachment_uploading({ progress: attachment.progress })
      : typeAndSize;
  // The preview is anchored to the tile and opened by it directly: a dialog trigger between the
  // tooltip and the tile would take the tooltip's hover from it.
  const tileRef = useRef<HTMLLIElement>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  return (
    <li ref={tileRef} data-attachment-failure={failure} className="group/tile relative shrink-0">
      <Tooltip title={failureDetail} isDisabled={!failure || previewOpen} placement="top start">
        <Button
          onPress={() => setPreviewOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={previewOpen}
          color="tertiary"
          size="sm"
          noTextPadding
          aria-label={`${name} · ${failure ? `${failureLabel}. ${failureDetail}` : status}`}
          className={cx(
            "overflow-hidden rounded-lg border border-primary bg-primary p-0 hover:bg-primary_hover",
            thumbnail ? "size-14" : "h-14 w-52 justify-start px-2.5",
            (retryable || reselectable) && "pr-10",
            failure && "border-error",
          )}
        >
          {thumbnail ? (
            previewUrl ? (
              <LoadingImage
                src={previewUrl}
                alt=""
                className="size-full"
                imgClassName={cx("size-full object-cover", uploading && "opacity-60")}
                failed={
                  <FileTypeIcon fileName={name} contentType={contentType} className="size-7" />
                }
              />
            ) : (
              <span className="flex size-full items-center justify-center bg-secondary">
                <FileTypeIcon fileName={name} contentType={contentType} className="size-7" />
              </span>
            )
          ) : (
            <span className="flex min-w-0 items-center gap-2 text-left">
              <span className="flex size-8 shrink-0 items-center justify-center">
                <FileTypeIcon fileName={name} contentType={contentType} className="size-8" />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium text-secondary">{name}</span>
                <span
                  className={cx(
                    "truncate text-xs",
                    failure ? "font-medium text-error-primary" : "text-tertiary",
                  )}
                >
                  {status}
                </span>
              </span>
            </span>
          )}
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
                    <FileTypeIcon fileName={name} contentType={contentType} className="size-10" />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-primary">{name}</p>
                  <p className="truncate text-sm text-tertiary">
                    {uploading && file
                      ? `${attachment.progress}% · ${formatFileSize(file.size)}`
                      : typeAndSize}
                  </p>
                  {uploading && <ProgressBar value={attachment.progress} className="mt-1.5" />}
                  {failureDetail && (
                    <p className="mt-0.5 text-sm text-error-primary">{failureDetail}</p>
                  )}
                </div>
                {previewUrl && (
                  <ButtonUtility
                    icon={Download01}
                    size="sm"
                    color="tertiary"
                    tooltip={m.conversation_attachment_download()}
                    href={previewUrl}
                    download={name}
                  />
                )}
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
      {retryable && (
        <ButtonUtility
          icon={RefreshCcw01}
          size="xs"
          color="tertiary"
          tooltip={`${m.controls_retry()} · ${name}`}
          onClick={onRetry}
          className="absolute top-1/2 right-2 -translate-y-1/2"
        />
      )}
      {reselectable && (
        <FileTrigger
          onSelect={(list) => {
            const picked = list?.[0];
            if (picked) onReplace?.(picked);
          }}
        >
          <ButtonUtility
            icon={RefreshCcw01}
            size="xs"
            color="tertiary"
            tooltip={m.conversation_attachment_reselect_named({ name })}
            className="absolute top-1/2 right-2 -translate-y-1/2"
          />
        </FileTrigger>
      )}
      {/* As Slack's composer: the remove button shows while the tile is hovered or holds focus,
          and stays on a touch screen, which has no hover, and on a tile still uploading or
          failed, which waits on the person. */}
      <ButtonUtility
        icon={XClose}
        size="xs"
        color="secondary"
        tooltip={m.conversation_attachment_remove_named({ name })}
        onClick={onRemove}
        className={cx(
          "absolute -top-2 -right-2 rounded-full bg-primary p-0.5 shadow-xs ring-1 ring-primary",
          !uploading &&
            !failure &&
            "opacity-0 transition-opacity group-focus-within/tile:opacity-100 group-hover/tile:opacity-100 any-pointer-coarse:opacity-100",
        )}
      />
    </li>
  );
}
