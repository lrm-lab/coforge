import { useState, type ReactNode } from "react";

import { Avatar, type AvatarProps } from "#src/components/base/avatar/avatar";
import { cx } from "#src/utils/cx";

import { DELETED_AGENT_AVATAR_CLASS, DELETED_AGENT_PICTURE_CLASS } from "./deleted-agent";
import { isMascotPicture } from "./mascot-contract";

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
 * An Agent's mascot as a sticker: the avatar's box and shape (`[data-avatar]` sets both, a
 * circle at `xs` and `sm`) as a light backdrop, the white-edged figure drawn at 110% of it and
 * unclipped (`.avatar-sticker`, `.avatar-sticker-figure` in `styles.css`), and a corner `badge`
 * (the status dot) over both. `children` is the figure: a still picture or a moving canvas.
 * `contentClassName` reaches the backdrop and figure together (a greyed archived Agent). `fill`
 * takes its parent's whole box as a circle instead of an avatar size (a channel's lone member).
 */
export function AvatarSticker({
  size = "md",
  className,
  contentClassName,
  badge,
  children,
}: {
  size?: AvatarSize | "fill";
  className?: string;
  contentClassName?: string;
  badge?: ReactNode;
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
      {badge}
    </div>
  );
}

/** The initial a sticker shows on its backdrop when its picture cannot load. */
export function StickerInitial({ initial }: { initial?: string }) {
  return (
    <span className="flex size-full items-center justify-center text-xs font-semibold text-quaternary">
      {initial}
    </span>
  );
}

/** A mascot's still picture filling a sticker's figure; one that cannot load shows `fallback`
 * instead (the Agent's initial on the backdrop), never an empty circle. */
export function StickerPicture({
  src,
  alt = "",
  fallback,
}: {
  src: string;
  alt?: string;
  fallback: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    fallback
  ) : (
    <img
      data-avatar-img
      src={src}
      alt={alt}
      className="size-full object-contain"
      onError={() => setFailed(true)}
    />
  );
}

/**
 * The avatar of anyone shown by their picture, a person or an Agent: an Agent's mascot picture
 * (`isMascotPicture`) as a sticker, anything else the base `Avatar` unchanged. Use it wherever a
 * picture may be either; an Agent known to be one goes through `AgentDisplayAvatar`. `deleted`
 * greys an archived Agent: its sticker, or the base avatar's tile.
 */
export function IdentityAvatar({
  deleted = false,
  ...props
}: Pick<AvatarProps, "size" | "src" | "alt" | "initials" | "className" | "contentClassName"> & {
  deleted?: boolean;
}) {
  const { src, size = "md", className, alt, initials } = props;
  if (!src || !isMascotPicture(src)) {
    return (
      <Avatar
        {...props}
        contentClassName={deleted ? DELETED_AGENT_AVATAR_CLASS : props.contentClassName}
      />
    );
  }
  // The initials' tone (`contentClassName`) has nothing to colour on a sticker.
  return (
    <AvatarSticker
      size={size}
      className={className}
      contentClassName={deleted ? DELETED_AGENT_PICTURE_CLASS : undefined}
    >
      <StickerPicture src={src} alt={alt} fallback={<StickerInitial initial={initials} />} />
    </AvatarSticker>
  );
}
