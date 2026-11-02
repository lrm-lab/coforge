import { useState } from "react";
import { Expand01 } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { m } from "#src/paraglide/messages";
import { AttachmentReviewDialog } from "./attachment-review";
import { MediaFailureActions, useInlineMedia } from "./inline-media";
import { inlineVideoBox } from "./inline-video-playback";
import { InlineVideoPlayer } from "./inline-video-player";
import { InlineVideoSpinner } from "./inline-video-spinner";
import type { MessageView } from "./message-view";

type Attachment = MessageView["attachments"][number];

/**
 * A message's video, shown in the message as a player the size of a lone image (`inlineVideoBox`),
 * as Raft and Telegram do. Nothing is read until it nears the screen (`useInlineMedia`); a spinner
 * holds its box until the video is known. A file the
 * browser cannot play, or one that failed to load, says so in its box and offers the download (and
 * a retry for a failed load). The top-right button opens the attachment's preview with its
 * comments, as the file card does, carrying on from where this player is (`MediaHandoff`).
 * `href` is the authenticated attachment route.
 */
export function InlineVideo({ attachment, href }: { attachment: Attachment; href: string }) {
  const media = useInlineMedia<HTMLVideoElement>(attachment, href);
  const [size, setSize] = useState<{ width: number; height: number }>();

  return (
    <div
      ref={media.watchNear}
      data-no-row-tap
      className="relative mt-1 max-w-full overflow-hidden rounded-[10px] bg-black"
      style={inlineVideoBox(size)}
    >
      {media.failure ? (
        <div
          role="alert"
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 text-center"
        >
          <p className="text-sm text-white">
            {media.failure === "unsupported"
              ? m.conversation_video_unsupported()
              : m.conversation_video_failed()}
          </p>
          <MediaFailureActions kind={media.failure} href={href} onRetry={media.retry} />
        </div>
      ) : media.player ? (
        <InlineVideoPlayer
          {...media.player}
          label={attachment.fileName}
          onSize={setSize}
          onFailed={media.onFailed}
          videoRef={media.element}
        />
      ) : (
        <InlineVideoSpinner />
      )}
      <AttachmentReviewDialog file={attachment} mediaHandoff={media.handoff}>
        {() => (
          <ButtonUtility
            icon={Expand01}
            size="xs"
            color="secondary"
            tooltip={m.conversation_video_expand({ name: attachment.fileName })}
            className="absolute top-2 right-2 z-10"
          />
        )}
      </AttachmentReviewDialog>
    </div>
  );
}
