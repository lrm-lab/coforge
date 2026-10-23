import { useCallback, useState, type ReactNode } from "react";

import type { AvatarProps } from "#src/components/base/avatar/avatar";
import { AvatarOnlineIndicator } from "#src/components/base/avatar/base-components";
import { cx } from "#src/utils/cx";

type AvatarSize = NonNullable<AvatarProps["size"]>;

/** The `Avatar` size classes, so a sticker takes the same box and `[data-avatar]` rules. */
const SIZE: Record<AvatarSize, string> = {
  xs: "size-6",
  sm: "size-8",
  md: "size-10",
  lg: "size-12",
  xl: "size-14",
  "2xl": "size-16",
};

/**
 * A platform figure (an Agent's mascot, a cartoon person) as a sticker: the bare white-edged figure,
 * with no circle or fill behind it, drawn at 110% of the avatar's box (`[data-avatar]` sets its
 * size and round shape) and unclipped (`.avatar-sticker`, `.avatar-sticker-figure` in
 * `styles.css`), and a corner `badge` (the status dot) or a member's presence `status` over it.
 * `children` is the figure: a still picture or a moving canvas. `contentClassName` reaches the
 * figure (a greyed archived Agent). `fill` takes its parent's whole box instead of an avatar size
 * (a channel's lone member).
 */
export function AvatarSticker({
  size = "md",
  className,
  contentClassName,
  badge,
  status,
  children,
}: {
  size?: AvatarSize | "fill";
  className?: string;
  contentClassName?: string;
  badge?: ReactNode;
  status?: AvatarProps["status"];
  children: ReactNode;
}) {
  return (
    <div
      {...(size === "fill" ? {} : { "data-avatar": true })}
      data-avatar-sticker
      className={cx(
        "relative inline-flex shrink-0 rounded-full",
        size === "fill" ? "size-full" : SIZE[size],
        className,
      )}
    >
      <div
        className={cx(
          "avatar-sticker inline-flex size-full shrink-0 rounded-[inherit]",
          contentClassName,
        )}
      >
        <span className="avatar-sticker-figure">{children}</span>
      </div>
      {status ? (
        <AvatarOnlineIndicator size={size === "fill" ? "md" : size} status={status} />
      ) : (
        badge
      )}
    </div>
  );
}

/** The initial a sticker shows, on a small round tile, when its picture cannot load. */
export function StickerInitial({ initial }: { initial?: string }) {
  return (
    <span className="m-auto flex size-[82%] items-center justify-center rounded-full bg-tertiary text-xs font-semibold text-quaternary">
      {initial}
    </span>
  );
}

/** A platform figure's still picture filling a sticker's figure; one that cannot load shows
 * `fallback` instead (the identity's initial), never an empty circle. */
export function StickerPicture({
  src,
  alt = "",
  fallback,
}: {
  src: string;
  alt?: string;
  fallback: ReactNode;
}) {
  // The picture that failed, so a changed `src` is tried afresh.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  // An image that failed before hydration never fires `onError` for React: check it once mounted.
  const check = useCallback(
    (img: HTMLImageElement | null) => {
      if (img?.complete && img.naturalWidth === 0) setFailedSrc(src);
    },
    [src],
  );
  return failedSrc === src ? (
    fallback
  ) : (
    <img
      ref={check}
      data-avatar-img
      src={src}
      alt={alt}
      className="size-full object-contain"
      onError={() => setFailedSrc(src)}
    />
  );
}
