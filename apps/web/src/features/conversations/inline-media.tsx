import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type SyntheticEvent,
} from "react";
import { Download01, RefreshCw01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { useNearViewport } from "#src/hooks/use-near-viewport";
import { m } from "#src/paraglide/messages";
import { joinExclusivePlayback } from "./media-exclusive";
import { inlineVideoErrorOutcome } from "./inline-video-playback";
import { useMediaSource } from "./media-source";
import type { MessageView } from "./message-view";
import { placeOf, resumeAt, type MediaHandoff, type MediaPlace } from "./media-handoff";

type Attachment = MessageView["attachments"][number];

export type MediaFailure = "unsupported" | "failed";

/** Draws a native player's controls in the app's theme: the theme is a class on the page, which
 * the browser's own controls do not see. */
export const NATIVE_CONTROLS_THEME = "scheme-light dark:scheme-dark";

/** How far outside the screen a message's video or audio file starts loading, so it is ready as it
 * scrolls in. */
const LOAD_MARGIN = "160px";

/**
 * What a message's video or audio player is built on (`InlineVideo`, `InlineAudio`): nothing is
 * read until it comes within `LOAD_MARGIN` of the screen, and once read it stays loaded; a failure
 * is held until `retry`, which starts again from the route (it signs a fresh delivery URL, or reads
 * the file again); and the `handoff` lets the preview carry on from the player (`MediaHandoff`).
 * `player` is what to play once the source is known; `element` is the player's ref.
 */
export function useInlineMedia<E extends HTMLMediaElement>(attachment: Attachment, href: string) {
  const [watchNear, nearNow] = useNearViewport(true, LOAD_MARGIN);
  const [near, setNear] = useState(false);
  if (nearNow && !near) setNear(true);
  const [failure, setFailure] = useState<MediaFailure>();
  const [attempt, setAttempt] = useState(0);
  const source = useMediaSource({
    fileName: attachment.fileName,
    href,
    previewUrl: attachment.previewUrl,
    enabled: near,
    attempt,
  });
  const element = useRef<E | null>(null);
  // Without delivery the player holds the whole file in memory: the preview plays that copy.
  const heldCopy = useRef<string | undefined>(undefined);
  heldCopy.current = !attachment.previewUrl && source.status === "ready" ? source.src : undefined;
  const handoff = useMemo<MediaHandoff>(
    () => ({
      take() {
        const media = element.current;
        if (!media) return undefined;
        const place = placeOf(media);
        media.pause();
        return { place, src: heldCopy.current };
      },
      give(place) {
        if (element.current) resumeAt(element.current, place);
      },
    }),
    [],
  );
  return {
    watchNear,
    element,
    handoff,
    failure: failure ?? (source.status === "error" ? ("failed" as const) : undefined),
    onFailed: setFailure,
    retry() {
      setFailure(undefined);
      setAttempt((count) => count + 1);
    },
    player:
      source.status === "ready"
        ? {
            key: attempt,
            src: (attempt > 0 && source.fallbackSrc) || source.src,
            fallbackSrc: attempt > 0 ? undefined : source.fallbackSrc,
          }
        : undefined,
  };
}

/**
 * A message's player on its source: it plays as the page's one video or audio file
 * (`joinExclusivePlayback`), an error on `src` moves to `fallbackSrc` at the same moment, playing
 * on from where it was (an expired signed URL), and one with nothing left to try goes to
 * `onFailed`. `onMetadata` hears each source's metadata arrive. Spread the result on the element.
 */
export function useMediaFallback<E extends HTMLMediaElement>({
  element,
  src,
  fallbackSrc,
  onFailed,
  onMetadata,
}: {
  element: RefObject<E | null>;
  src: string;
  fallbackSrc?: string;
  onFailed: (outcome: MediaFailure) => void;
  onMetadata?: (element: E) => void;
}) {
  const [onFallback, setOnFallback] = useState(false);
  const metadataLoaded = useRef(false);
  // Where to pick up after a move to the fallback.
  const resume = useRef<MediaPlace | null>(null);

  const onError = () => {
    const media = element.current;
    if (!media) return;
    const outcome = inlineVideoErrorOutcome({
      code: media.error?.code,
      hasFallback: fallbackSrc !== undefined && !onFallback,
      metadataLoaded: metadataLoaded.current,
      online: navigator.onLine,
    });
    if (outcome !== "fallback") return onFailed(outcome);
    resume.current = { time: media.currentTime, playing: !media.paused };
    // The fallback's own metadata decides whether a later error is the format's.
    metadataLoaded.current = false;
    setOnFallback(true);
  };

  const onLoadedMetadata = () => {
    const media = element.current;
    if (!media) return;
    metadataLoaded.current = true;
    onMetadata?.(media);
    const pickUp = resume.current;
    if (!pickUp) return;
    resume.current = null;
    media.currentTime = pickUp.time;
    if (pickUp.playing) media.play().catch(() => {});
  };

  // A file the browser already holds can have its metadata, or its error, before
  // the events' listeners are attached: the element is checked once on mount.
  const catchUp = useEffectEvent((media: E) => {
    if (media.error) return onError();
    if (media.readyState >= HTMLMediaElement.HAVE_METADATA) onLoadedMetadata();
  });

  useEffect(() => {
    const media = element.current;
    if (!media) return;
    catchUp(media);
    return joinExclusivePlayback(media);
  }, [element]);

  return {
    src: onFallback ? fallbackSrc : src,
    onError: (_event: SyntheticEvent<E>) => onError(),
    onLoadedMetadata: (_event: SyntheticEvent<E>) => onLoadedMetadata(),
  };
}

/** A failed player's way out: a retry for a failed load, and the download. */
export function MediaFailureActions({
  kind,
  href,
  onRetry,
}: {
  kind: MediaFailure;
  href: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex shrink-0 gap-2">
      {kind === "failed" && (
        <Button size="sm" color="secondary" iconLeading={RefreshCw01} onClick={onRetry}>
          {m.conversation_video_retry()}
        </Button>
      )}
      <Button size="sm" color="secondary" iconLeading={Download01} href={`${href}?download`}>
        {m.conversation_attachment_download()}
      </Button>
    </div>
  );
}
