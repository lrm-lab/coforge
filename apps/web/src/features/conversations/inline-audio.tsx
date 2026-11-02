import type { RefObject } from "react";
import { Download01 } from "@untitledui/icons";

import { getReadableFileSize } from "#src/components/application/file-upload/file-upload-base";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Spinner } from "#src/components/ui/spinner";
import { MESSAGE_GALLERY_MAX_WIDTH_PX } from "#src/lib/attachment-image-box";
import { m } from "#src/paraglide/messages";
import { CommentCountMark, commentsSuffix, FileTypeTag } from "./attachment-meta";
import { AttachmentReviewDialog } from "./attachment-review";
import {
  MediaFailureActions,
  NATIVE_CONTROLS_THEME,
  useInlineMedia,
  useMediaFallback,
  type MediaFailure,
} from "./inline-media";
import type { MessageView } from "./message-view";

type Attachment = MessageView["attachments"][number];

/** The player's height, held by the spinner and the failure line so the card never jumps. */
const BAR = "h-10";

/**
 * A message's audio file, played in the message as Raft does (task #419): a card as wide as the
 * image grid with its name on top, which opens the preview and its comments, the download beside
 * it (the player's own menu has none on a phone's Safari), and the browser's own player under it.
 * The card is a row of its own, not one of the two-to-a-row file cards: the player's seek bar needs
 * the width. From a delivery URL only the length is read until play (`useInlineMedia`). It plays
 * one at a time with the page's videos, and the preview carries on from where it is.
 */
export function InlineAudio({ attachment, href }: { attachment: Attachment; href: string }) {
  const media = useInlineMedia<HTMLAudioElement>(attachment, href);
  const commentCount = attachment.commentCount ?? 0;

  return (
    <div
      ref={media.watchNear}
      data-no-row-tap
      className="mt-1 flex w-full flex-col gap-1 rounded-[10px] bg-primary p-1.5 ring-1 ring-secondary ring-inset"
      style={{ maxWidth: `min(${MESSAGE_GALLERY_MAX_WIDTH_PX}px, 100%)` }}
    >
      <div className="flex min-w-0 items-center gap-1">
        <AttachmentReviewDialog file={attachment} videoHandoff={media.handoff}>
          {({ loading }) => (
            <Button
              color="tertiary"
              noTextPadding
              isLoading={loading}
              aria-label={`${m.conversation_attachment_preview_open({ name: attachment.fileName })}${commentsSuffix(commentCount)}`}
              className="h-auto min-w-0 flex-1 justify-start rounded-md px-1.5 py-1 [&>span]:w-full [&>span]:min-w-0"
            >
              <span className="flex min-w-0 items-center gap-1.5 text-left">
                <FileTypeTag fileName={attachment.fileName} contentType={attachment.contentType} />
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-primary">
                  {attachment.fileName}
                </span>
                <span className="flex shrink-0 items-center gap-1.5 text-xs text-tertiary tabular-nums">
                  <CommentCountMark count={commentCount} />
                  {getReadableFileSize(attachment.sizeBytes)}
                </span>
              </span>
            </Button>
          )}
        </AttachmentReviewDialog>
        <ButtonUtility
          icon={Download01}
          size="xs"
          color="tertiary"
          tooltip={m.attachment_preview_download({ name: attachment.fileName })}
          href={`${href}?download`}
        />
      </div>
      {media.failure ? (
        <div role="alert" className={`flex ${BAR} items-center gap-2 px-1.5`}>
          <p className="min-w-0 flex-1 truncate text-sm text-tertiary">
            {media.failure === "unsupported"
              ? m.conversation_audio_unsupported()
              : m.conversation_audio_failed()}
          </p>
          <MediaFailureActions kind={media.failure} href={href} onRetry={media.retry} />
        </div>
      ) : media.player ? (
        <InlineAudioPlayer
          {...media.player}
          label={attachment.fileName}
          onFailed={media.onFailed}
          audioRef={media.element}
        />
      ) : (
        <span
          role="status"
          aria-label={m.conversation_audio_loading()}
          className={`flex ${BAR} items-center justify-center text-fg-quaternary`}
        >
          <Spinner className="size-5" />
        </span>
      )}
    </div>
  );
}

/** The browser's own audio player, its controls in the app's theme (`useMediaFallback`). */
function InlineAudioPlayer({
  src,
  fallbackSrc,
  label,
  onFailed,
  audioRef,
}: {
  src: string;
  fallbackSrc?: string;
  label: string;
  onFailed: (outcome: MediaFailure) => void;
  audioRef: RefObject<HTMLAudioElement | null>;
}) {
  const playback = useMediaFallback({ element: audioRef, src, fallbackSrc, onFailed });
  return (
    <audio
      ref={audioRef}
      {...playback}
      controls
      preload="metadata"
      aria-label={label}
      className={`${BAR} w-full ${NATIVE_CONTROLS_THEME}`}
    />
  );
}
