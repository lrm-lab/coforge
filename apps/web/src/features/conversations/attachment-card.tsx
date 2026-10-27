import { useState } from "react";
import { Download01 } from "@untitledui/icons";
import { getReadableFileSize } from "#src/components/application/file-upload/file-upload-base";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { fileTypeLabel } from "#src/features/files/file-meta";
import { FileTypeIcon } from "#src/features/files/file-type-icon";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { previewKindFor } from "./attachment-preview-kind";
import { AttachmentReviewDialog } from "./attachment-review";
import { LoadingImage } from "./loading-image";
import {
  MESSAGE_IMAGE_MAX_HEIGHT_PX,
  MESSAGE_IMAGE_MAX_WIDTH_PX,
} from "#src/lib/attachment-image-box";
import type { MessageView } from "./message-row";

/** The authenticated backend fallback: forced downloads, and inline images once their signed
 * CDN preview URL has expired or fails to load (the route then redirects to a fresh one, or
 * streams the bytes when CDN delivery is not configured). */
export function attachmentUrl(attachment: { id: string }) {
  return `/api/attachments/${attachment.id}`;
}

/**
 * An image's final box while it is still loading, from the size the server read off the upload:
 * its pixels as CSS pixels, scaled down into the message box (`attachment-image-box.ts`, which the
 * server sizes the thumbnail to). The card takes that width, capped
 * by the row (`max-w-full`), and the frame fills it at the image's ratio. Without a size the frame
 * stays at its minimum until the image arrives.
 */
function imageBox({ imageWidth: width, imageHeight: height }: MessageView["attachments"][number]) {
  if (!width || !height) return undefined;
  return {
    width: `${Math.min(width, MESSAGE_IMAGE_MAX_WIDTH_PX, (MESSAGE_IMAGE_MAX_HEIGHT_PX * width) / height)}px`,
    aspectRatio: `${width} / ${height}`,
  };
}

const IMAGE_BUTTON_CLASS =
  "h-auto overflow-hidden rounded-lg p-0 ring-1 ring-secondary ring-inset hover:bg-transparent";

export function AttachmentCard({ attachment }: { attachment: MessageView["attachments"][number] }) {
  const href = attachmentUrl(attachment);
  const [imgBroken, setImgBroken] = useState(false);
  const box = imageBox(attachment);
  if (attachment.contentType.startsWith("image/") && !imgBroken)
    return (
      <div
        className="relative mt-1 w-fit"
        style={{
          maxWidth: `min(100%, ${MESSAGE_IMAGE_MAX_WIDTH_PX}px)`,
          ...(box && { width: box.width }),
        }}
      >
        <AttachmentReviewDialog file={attachment}>
          {() => (
            <Button
              color="tertiary"
              noTextPadding
              aria-label={attachment.fileName}
              className={cn(box ? "block w-full" : "grid place-items-center", IMAGE_BUTTON_CLASS)}
            >
              <LoadingImage
                src={attachment.thumbnailUrl ?? attachment.previewUrl ?? href}
                fallbackSrc={attachment.thumbnailUrl || attachment.previewUrl ? href : undefined}
                onFailed={() => setImgBroken(true)}
                alt={attachment.fileName}
                className={cn("min-h-24 min-w-24", box ? "w-full" : "max-w-full")}
                style={box && { aspectRatio: box.aspectRatio }}
                imgClassName={
                  box
                    ? "block size-full object-contain"
                    : "block max-h-80 max-w-full object-contain"
                }
              />
            </Button>
          )}
        </AttachmentReviewDialog>
      </div>
    );
  const typeLabel = fileTypeLabel(attachment.fileName, attachment.contentType);
  const previewable = previewKindFor(attachment);
  return (
    <div className="group/attachment mt-1 flex w-full max-w-sm min-w-0 items-center rounded-xl bg-primary ring-1 ring-secondary ring-inset">
      <AttachmentReviewDialog file={attachment}>
        {({ loading }) => (
          <Button
            color="tertiary"
            noTextPadding
            isLoading={loading}
            aria-label={
              previewable
                ? m.conversation_attachment_preview_open({ name: attachment.fileName })
                : m.attachment_comments_open({ name: attachment.fileName })
            }
            className="h-auto min-w-0 flex-1 justify-start rounded-xl rounded-r-none p-3 hover:bg-secondary [&>span]:w-full [&>span]:min-w-0"
          >
            <span className="flex min-w-0 items-center gap-3 text-left">
              <FileTypeIcon
                fileName={attachment.fileName}
                contentType={attachment.contentType}
                className="size-10 shrink-0"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-primary">
                  {attachment.fileName}
                </span>
                <span className="block truncate text-xs text-tertiary">
                  {typeLabel ? `${typeLabel} · ` : ""}
                  {getReadableFileSize(attachment.sizeBytes)}
                </span>
              </span>
            </span>
          </Button>
        )}
      </AttachmentReviewDialog>
      <span className="mx-1 h-8 w-px shrink-0 bg-border-secondary" aria-hidden="true" />
      <div className="shrink-0 pr-2">
        <ButtonUtility
          icon={Download01}
          size="xs"
          color="secondary"
          tooltip={m.conversation_attachment_download()}
          href={`${href}?download`}
        />
      </div>
    </div>
  );
}
