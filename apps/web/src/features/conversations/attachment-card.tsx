import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Download01 } from "@untitledui/icons";
import { getReadableFileSize } from "#src/components/application/file-upload/file-upload-base";
import { Button } from "#src/components/base/buttons/button";
import { isDisplayableImageAttachment } from "#src/lib/inline-image";
import {
  captureElementRect,
  isRectInViewport,
  type SharedRect,
} from "#src/lib/shared-element-rect";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { attachmentPreviewKind, previewKindFor } from "./attachment-preview-kind";
import { CommentCountMark, commentsSuffix, FileTypeTag } from "./attachment-meta";
import { InlineAudio } from "./inline-audio";
import { AttachmentReviewDialog } from "./attachment-review";
import { useAttachmentReviewAddressAmong } from "./attachment-review-address";
import { ImageLightbox } from "./image-lightbox";
import { InlineVideo } from "./inline-video";
import { MEDIA_PREVIEW_MAX_BYTES } from "./media-source";
import { LoadingImage } from "./loading-image";
import {
  MESSAGE_GALLERY_MAX_WIDTH_PX,
  galleryRows,
  singleImageBox,
} from "#src/lib/attachment-image-box";
import { SaveAttachmentAsArtifactButton } from "#src/features/artifacts/artifact-attachment-save";
import type { MessageView } from "./message-view";

export function attachmentUrl(attachment: { id: string }) {
  return `/api/attachments/${attachment.id}`;
}

type Attachment = MessageView["attachments"][number];

const isImage = (attachment: Attachment) => isDisplayableImageAttachment(attachment);
function playsInline(attachment: Attachment) {
  const kind = attachmentPreviewKind(attachment.fileName, attachment.contentType);
  if (kind !== "video" && kind !== "audio") return undefined;
  return attachment.previewUrl !== undefined || attachment.sizeBytes <= MEDIA_PREVIEW_MAX_BYTES
    ? kind
    : undefined;
}

function ImageThumbnail({
  attachment,
  className,
  style,
  imgClassName,
  hidden,
  registerNode,
  onFailed,
  onOpen,
}: {
  attachment: Attachment;
  className?: string;
  style?: CSSProperties;
  imgClassName: string;
  hidden?: boolean;
  registerNode?: (node: HTMLElement | null) => void;
  onFailed?: () => void;
  onOpen: () => void;
}) {
  const href = attachmentUrl(attachment);
  return (
    <Button
      color="tertiary"
      noTextPadding
      aria-label={attachment.fileName}
      className={cn(
        "block h-auto overflow-hidden border border-image-frame-border bg-image-frame p-0 hover:bg-image-frame [&>span]:block [&>span]:size-full",
        hidden && "opacity-0",
        className,
      )}
      style={style}
      onClick={onOpen}
    >
      <span ref={registerNode} className="block size-full">
        <LoadingImage
          src={attachment.thumbnailUrl ?? attachment.previewUrl ?? href}
          fallbackSrc={attachment.thumbnailUrl || attachment.previewUrl ? href : undefined}
          onFailed={onFailed}
          alt={attachment.fileName}
          className="size-full"
          imgClassName={cn("block size-full", imgClassName)}
        />
      </span>
    </Button>
  );
}

export function MessageAttachments({ attachments }: { attachments: readonly Attachment[] }) {
  const [brokenId, setBrokenId] = useState<string>();
  const [viewingId, setViewingId] = useState<string | null>(null);
  const thumbNodes = useRef<Map<string, HTMLElement>>(new Map());
  const images = attachments.filter(isImage);
  const viewing = images.findIndex((image) => image.id === viewingId);
  const address = useAttachmentReviewAddressAmong(images.map((image) => image.id));
  const [linkedId, setLinkedId] = useState<string>();
  const [atComments, setAtComments] = useState(false);
  const followAddress = useEffectEvent((fileId: string | undefined) => {
    if (fileId === linkedId) return;
    address.release();
    const next = fileId && address.follow() ? fileId : undefined;
    if (next === linkedId) return;
    setLinkedId(next);
    setAtComments(next !== undefined && address.commentId !== undefined);
    setViewingId(next ?? null);
  });
  const view = (id: string) => {
    setLinkedId(id);
    setAtComments(false);
    setViewingId(id);
    address.show(id);
  };
  useEffect(() => followAddress(address.fileId), [address.fileId]);
  const registerThumb = useCallback((id: string) => {
    return (node: HTMLElement | null) => {
      if (node) thumbNodes.current.set(id, node);
      else thumbNodes.current.delete(id);
    };
  }, []);
  const getOriginRect = useCallback((id: string): SharedRect | null => {
    const node = thumbNodes.current.get(id);
    const target = node?.closest("button") ?? node;
    const rect = captureElementRect(target);
    return rect && isRectInViewport(rect) ? rect : null;
  }, []);
  const videos: Attachment[] = [];
  const audios: Attachment[] = [];
  const files: Attachment[] = [];
  for (const attachment of attachments) {
    if (isImage(attachment)) continue;
    const inline = playsInline(attachment);
    (inline === "video" ? videos : inline === "audio" ? audios : files).push(attachment);
  }
  const lone = images.length === 1 ? images[0]! : undefined;
  const broken = lone !== undefined && brokenId === lone.id;
  if (lone && broken) files.unshift(lone);
  const rows = images.length > 1 ? galleryRows(images) : [];
  return (
    <>
      {lone && !broken && (
        <div className="mt-1 flex">
          <ImageThumbnail
            attachment={lone}
            className="max-w-full rounded-lg"
            style={singleImageBox(lone)}
            imgClassName="object-contain"
            hidden={viewingId === lone.id}
            registerNode={registerThumb(lone.id)}
            onFailed={() => setBrokenId(lone.id)}
            onOpen={() => view(lone.id)}
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
              key={row.map((cell) => cell.index).join()}
              className={cn(
                "grid gap-1",
                row.length === 1 ? "grid-cols-1" : "grid-cols-2",
                row.length === 3
                  ? "auto-rows-[7rem] @min-[360px]:auto-rows-[8rem]"
                  : "auto-rows-[8rem] @min-[360px]:auto-rows-[9rem]",
              )}
            >
              {row.map(({ index, fit }) => {
                const img = images[index]!;
                return (
                  <ImageThumbnail
                    key={img.id}
                    attachment={img}
                    className="size-full rounded-lg"
                    imgClassName={fit === "cover" ? "object-cover" : "object-contain"}
                    hidden={viewingId === img.id}
                    registerNode={registerThumb(img.id)}
                    onOpen={() => view(img.id)}
                  />
                );
              })}
            </div>
          ))}
        </div>
      )}
      {viewing >= 0 && (
        <ImageLightbox
          images={images}
          index={viewing}
          onIndexChange={(index) => view(images[index]!.id)}
          isOpen
          getOriginRect={getOriginRect}
          onOpenChange={(open) => {
            if (open) return;
            setViewingId(null);
            if (linkedId) address.clear();
          }}
          commentsOpen={atComments}
          focusCommentId={atComments ? address.commentId : undefined}
        />
      )}
      {videos.map((attachment) => (
        <InlineVideo key={attachment.id} attachment={attachment} href={attachmentUrl(attachment)} />
      ))}
      {audios.map((attachment) => (
        <InlineAudio key={attachment.id} attachment={attachment} href={attachmentUrl(attachment)} />
      ))}
      {files.length > 0 && (
        // Two cards to a row, as wide as the image grid above them.
        <div
          className="mt-1 grid w-full grid-cols-2 gap-1"
          style={{ maxWidth: `min(${MESSAGE_GALLERY_MAX_WIDTH_PX}px, 100%)` }}
        >
          {files.map((attachment) => (
            <AttachmentCard key={attachment.id} attachment={attachment} />
          ))}
        </div>
      )}
    </>
  );
}

/** The card's own button: the whole card opens the file's preview, or downloads it. */
const CARD =
  "h-auto w-full min-w-0 justify-start rounded-lg bg-primary px-2.5 py-2 ring-1 ring-secondary ring-inset hover:bg-primary_hover [&>span]:w-full [&>span]:min-w-0";

/**
 * One non-image file, laid out as Raft does (fixed width, two to a row in the image grid's width)
 * with two lines instead of its three (task #238): its type and name, then its size. The card opens
 * the file's preview; a file with none downloads instead, and only that card shows a download
 * mark, so the two read apart at a glance. Raft's description line ("Markdown 文档") and its
 * "Markdown 预览" repeat the type tag, so they are left out on purpose.
 */
function AttachmentCard({ attachment }: { attachment: Attachment }) {
  const previewable = previewKindFor(attachment);
  const commentCount = attachment.commentCount ?? 0;
  // The count is drawn as a mark; the card's name says it in words.
  const comments = commentsSuffix(commentCount);
  const body = (
    <span className="flex min-w-0 flex-col gap-1 text-left">
      <span className="flex min-w-0 items-center gap-1.5">
        <FileTypeTag fileName={attachment.fileName} contentType={attachment.contentType} />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-primary">
          {attachment.fileName}
        </span>
      </span>
      <span className="flex min-w-0 items-center justify-between gap-2 text-xs text-tertiary tabular-nums">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate">{getReadableFileSize(attachment.sizeBytes)}</span>
          <CommentCountMark count={commentCount} />
        </span>
        {!previewable && <Download01 aria-hidden="true" className="size-3.5 shrink-0" />}
      </span>
    </span>
  );
  const card = previewable ? (
    <AttachmentReviewDialog file={attachment}>
      {({ loading }) => (
        <Button
          color="tertiary"
          noTextPadding
          isLoading={loading}
          aria-label={`${m.conversation_attachment_preview_open({ name: attachment.fileName })}${comments}`}
          className={CARD}
        >
          {body}
        </Button>
      )}
    </AttachmentReviewDialog>
  ) : (
    <Button
      color="tertiary"
      noTextPadding
      href={`${attachmentUrl(attachment)}?download`}
      aria-label={`${m.attachment_preview_download({ name: attachment.fileName })}${comments}`}
      className={CARD}
    >
      {body}
    </Button>
  );
  return (
    <div className="group/att relative min-w-0">
      {card}
      <div className="absolute top-1 right-1 z-10">
        <SaveAttachmentAsArtifactButton
          attachmentId={attachment.id}
          sizeBytes={attachment.sizeBytes}
        />
      </div>
    </div>
  );
}
