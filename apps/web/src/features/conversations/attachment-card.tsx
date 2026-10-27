import { useState, type CSSProperties } from "react";
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
  MESSAGE_GALLERY_MAX_WIDTH_PX,
  galleryRows,
  singleImageBox,
} from "#src/lib/attachment-image-box";
import type { MessageView } from "./message-row";

/** The authenticated backend fallback: forced downloads, and inline images once their signed
 * CDN preview URL has expired or fails to load (the route then redirects to a fresh one, or
 * streams the bytes when CDN delivery is not configured). */
export function attachmentUrl(attachment: { id: string }) {
  return `/api/attachments/${attachment.id}`;
}

type Attachment = MessageView["attachments"][number];

const isImage = (attachment: Attachment) => attachment.contentType.startsWith("image/");

/** The image a message shows first: its thumbnail, else the original, else the backend route. */
function ImageThumbnail({
  attachment,
  className,
  style,
  imgClassName,
  onFailed,
}: {
  attachment: Attachment;
  className?: string;
  style?: CSSProperties;
  imgClassName: string;
  onFailed?: () => void;
}) {
  const href = attachmentUrl(attachment);
  return (
    <AttachmentReviewDialog file={attachment}>
      {() => (
        <Button
          color="tertiary"
          noTextPadding
          aria-label={attachment.fileName}
          className={cn(
            "block h-auto overflow-hidden border border-secondary bg-tertiary p-0 hover:bg-tertiary [&>span]:block [&>span]:size-full",
            className,
          )}
          style={style}
        >
          <LoadingImage
            src={attachment.thumbnailUrl ?? attachment.previewUrl ?? href}
            fallbackSrc={attachment.thumbnailUrl || attachment.previewUrl ? href : undefined}
            onFailed={onFailed}
            alt={attachment.fileName}
            className="size-full"
            imgClassName={cn("block size-full", imgClassName)}
          />
        </Button>
      )}
    </AttachmentReviewDialog>
  );
}

/**
 * A message's attachments: its images first, laid out as Raft does (`attachment-image-box.ts`), a
 * lone one at its own shape and several in a grid, then a card for each other file. A lone image
 * that cannot be loaded falls back to its file card.
 */
export function MessageAttachments({ attachments }: { attachments: readonly Attachment[] }) {
  const [broken, setBroken] = useState(false);
  const images = attachments.filter(isImage);
  const files = attachments.filter((attachment) => !isImage(attachment));
  const lone = images.length === 1 ? images[0]! : undefined;
  if (lone && broken) files.unshift(lone);
  const rows = images.length > 1 ? galleryRows(images) : [];
  return (
    <>
      {lone && !broken && (
        <div className="mt-1 flex">
          <ImageThumbnail
            attachment={lone}
            className="max-w-full rounded-[10px]"
            style={singleImageBox(lone)}
            imgClassName="object-contain"
            onFailed={() => setBroken(true)}
          />
        </div>
      )}
      {rows.length > 0 && (
        <div
          className="@container mt-1 flex w-full flex-col gap-1"
          style={{ maxWidth: `min(${MESSAGE_GALLERY_MAX_WIDTH_PX}px, 100%)` }}
        >
          {rows.map((row) => (
            <div
              key={row.indexes.join()}
              className={cn(
                "grid gap-1",
                row.indexes.length === 1 ? "grid-cols-1" : "grid-cols-2",
                row.indexes.length === 3
                  ? "auto-rows-[7rem] @min-[360px]:auto-rows-[8rem]"
                  : "auto-rows-[8rem] @min-[360px]:auto-rows-[9rem]",
              )}
            >
              {row.indexes.map((index, cell) => (
                <ImageThumbnail
                  key={images[index]!.id}
                  attachment={images[index]!}
                  className="size-full rounded-lg"
                  imgClassName={row.fit[cell] === "cover" ? "object-cover" : "object-contain"}
                />
              ))}
            </div>
          ))}
        </div>
      )}
      {files.map((attachment) => (
        <AttachmentCard key={attachment.id} attachment={attachment} />
      ))}
    </>
  );
}

/** One non-image file: its type, name and size, opening its preview, with a Download button. */
function AttachmentCard({ attachment }: { attachment: Attachment }) {
  const href = attachmentUrl(attachment);
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
