import { useEffect, useState } from "react";
import { AlertCircle, Download01, Trash01 } from "@untitledui/icons";
import { Popover as AriaPopover } from "react-aria-components";

import { getReadableFileSize } from "#src/components/application/file-upload/file-upload-base";
import { Dialog, DialogTrigger } from "#src/components/application/modals/modal";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import {
  ProgressBar,
  ProgressBarBase,
} from "#src/components/base/progress-indicators/progress-indicators";
import { FileTypeIcon } from "#src/features/files/file-type-icon";
import { fileTypeLabel } from "#src/features/files/file-meta";
import { cx } from "#src/utils/cx";
import { m } from "#src/paraglide/messages";

export type PendingAttachment = {
  /** Stable key across renders and across the file's own upload lifecycle; independent of
   * `file` identity so two same-named files can coexist. */
  localId: string;
  file: File;
  /** Set once the server has accepted the upload. */
  id?: string;
  /** 0 to 100 while uploading. */
  progress: number;
  failed: boolean;
};

/** Upload a composer attachment, reporting progress, and resolve with its id. */
export function uploadAttachment(
  conversationId: string,
  file: File,
  onProgress: (percent: number) => void,
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
      } else reject(new Error(request.responseText || `upload failed (${request.status})`));
    };
    request.onerror = () => reject(new Error("upload failed"));
    request.send(form);
  });
}

/**
 * One chosen file in the tray under the text, as Slack shows them: an image
 * is a 4rem thumbnail, any other file a card with its type icon, name and size, so a chosen
 * file is visible at a glance. While it uploads it is dimmed with a progress bar along its
 * foot; a failed upload rings it red. Clicking the tile opens the preview with the file's details, download, remove, and retry for a failed upload.
 */
export function AttachmentTile({
  attachment,
  uploading,
  onRemove,
  onRetry,
}: {
  attachment: PendingAttachment;
  uploading: boolean;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const { file } = attachment;
  const isImage = file.type.startsWith("image/");
  const [previewUrl, setPreviewUrl] = useState<string>();
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const typeLabel = fileTypeLabel(file.name, file.type);
  const typeAndSize = `${typeLabel ? `${typeLabel} · ` : ""}${getReadableFileSize(file.size)}`;
  const status = attachment.failed
    ? m.conversation_attachment_failed()
    : uploading
      ? m.conversation_attachment_uploading({ progress: attachment.progress })
      : typeAndSize;
  return (
    <li className="relative">
      <DialogTrigger>
        <Button
          color="tertiary"
          size="sm"
          noTextPadding
          aria-label={`${file.name} · ${status}`}
          className={cx(
            "overflow-hidden rounded-lg border border-primary bg-primary p-0 shadow-xs hover:bg-primary_hover",
            isImage ? "size-16" : "h-16 w-[13rem] justify-start px-3",
            attachment.failed && "border-error",
          )}
        >
          {isImage ? (
            previewUrl ? (
              <img
                src={previewUrl}
                alt=""
                className={cx("size-full object-cover", uploading && "opacity-60")}
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
                <span
                  className={cx(
                    "truncate text-xs",
                    attachment.failed ? "text-error-primary" : "text-tertiary",
                  )}
                >
                  {status}
                </span>
              </span>
            </span>
          )}
        </Button>
        <AriaPopover
          placement="top start"
          offset={8}
          className="w-[min(24rem,calc(100vw-2rem))] rounded-xl bg-primary shadow-lg ring-1 ring-secondary_alt outline-none"
        >
          <Dialog className="flex flex-col outline-none">
            {({ close }) => (
              <>
                {isImage && previewUrl && (
                  <div className="flex justify-center rounded-t-xl bg-secondary p-3">
                    <img
                      src={previewUrl}
                      alt=""
                      className="max-h-56 max-w-full rounded-md object-contain"
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
                    {attachment.failed && (
                      <Button color="link-color" size="sm" onPress={onRetry} className="mt-1">
                        {m.controls_retry()}
                      </Button>
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
      </DialogTrigger>
      {uploading && (
        <ProgressBarBase
          value={attachment.progress}
          className="pointer-events-none absolute inset-x-2 bottom-1.5 h-1 w-auto"
        />
      )}
      {attachment.failed && isImage && (
        <AlertCircle
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-1/2 size-6 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary text-fg-error-primary"
        />
      )}
    </li>
  );
}
