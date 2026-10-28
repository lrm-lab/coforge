import { useState } from "react";
import { Download01, Expand01, RefreshCw01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { useNearViewport } from "#src/hooks/use-near-viewport";
import { m } from "#src/paraglide/messages";
import { AttachmentReviewDialog } from "./attachment-review";
import { inlineVideoBox } from "./inline-video-playback";
import { InlineVideoPlayer } from "./inline-video-player";
import { InlineVideoSpinner } from "./inline-video-spinner";
import { useMediaSource } from "./media-source";
import type { MessageView } from "./message-view";

type Attachment = MessageView["attachments"][number];

/** How far outside the screen a video starts loading, so it is ready as it scrolls in. */
const LOAD_MARGIN = "160px";

/**
 * A message's video, shown in the message as a player the size of a lone image (`inlineVideoBox`),
 * as Raft and Telegram do. Nothing is read until it comes within
 * `LOAD_MARGIN` of the screen; a spinner holds its box until the video is known. A file the
 * browser cannot play, or one that failed to load, says so in its box and offers the download (and
 * a retry for a failed load). The top-right button opens the attachment's preview with its
 * comments, as the file card does. `href` is the authenticated attachment route.
 */
export function InlineVideo({ attachment, href }: { attachment: Attachment; href: string }) {
  const [watchNear, nearNow] = useNearViewport(true, LOAD_MARGIN);
  // Once read, a video stays loaded when it scrolls away.
  const [near, setNear] = useState(false);
  if (nearNow && !near) setNear(true);
  const [size, setSize] = useState<{ width: number; height: number }>();
  const [failure, setFailure] = useState<"unsupported" | "failed">();
  const [attempt, setAttempt] = useState(0);
  const source = useMediaSource({
    fileName: attachment.fileName,
    href,
    previewUrl: attachment.previewUrl,
    enabled: near,
    attempt,
  });
  const shownFailure = failure ?? (source.status === "error" ? "failed" : undefined);
  const retry = () => {
    setFailure(undefined);
    setAttempt((count) => count + 1);
  };

  return (
    <div
      ref={watchNear}
      data-no-row-tap
      className="relative mt-1 max-w-full overflow-hidden rounded-[10px] bg-black"
      style={inlineVideoBox(size)}
    >
      {shownFailure ? (
        <VideoFailure kind={shownFailure} href={href} onRetry={retry} />
      ) : source.status === "ready" ? (
        <InlineVideoPlayer
          key={attempt}
          // A retry starts from the route: it signs a fresh delivery URL, or reads the file again.
          src={(attempt > 0 && source.fallbackSrc) || source.src}
          fallbackSrc={attempt > 0 ? undefined : source.fallbackSrc}
          label={attachment.fileName}
          onSize={setSize}
          onFailed={setFailure}
        />
      ) : (
        <InlineVideoSpinner />
      )}
      <AttachmentReviewDialog file={attachment}>
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

function VideoFailure({
  kind,
  href,
  onRetry,
}: {
  kind: "unsupported" | "failed";
  href: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 text-center"
    >
      <p className="text-sm text-white">
        {kind === "unsupported"
          ? m.conversation_video_unsupported()
          : m.conversation_video_failed()}
      </p>
      <div className="flex gap-2">
        {kind === "failed" && (
          <Button size="sm" color="secondary" iconLeading={RefreshCw01} onClick={onRetry}>
            {m.conversation_video_retry()}
          </Button>
        )}
        <Button size="sm" color="secondary" iconLeading={Download01} href={`${href}?download`}>
          {m.conversation_attachment_download()}
        </Button>
      </div>
    </div>
  );
}
