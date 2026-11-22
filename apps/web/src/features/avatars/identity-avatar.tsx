import { Avatar, type AvatarProps } from "#src/components/base/avatar/avatar";
import { useAvatarImageFallback } from "#src/hooks/use-image-fallback";
import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
import { isPersonPicture, personAvatarUrl } from "#src/lib/person-picture";
import { cx } from "#src/utils/cx";

import { AvatarSticker, StickerInitial, StickerPicture } from "./avatar-sticker";
import { DELETED_AVATAR_CLASS, DELETED_PICTURE_CLASS } from "./deleted-avatar";
import { isStickerPicture } from "./sticker-picture";

export type IdentityAvatarProps = Pick<
  AvatarProps,
  | "size"
  | "src"
  | "alt"
  | "initials"
  | "className"
  | "contentClassName"
  | "status"
  | "badge"
  | "rounded"
> & {
  name?: string;
  userId?: string;
  deleted?: boolean;
};

export function IdentityAvatar({
  name,
  userId,
  alt = "",
  deleted = false,
  src: given,
  initials = name === undefined ? undefined : avatarInitial(name),
  contentClassName = name === undefined ? undefined : avatarToneClassName(name),
  ...props
}: IdentityAvatarProps) {
  const src = userId ? personAvatarUrl(userId, given) : given;
  const sticker = Boolean(src && isStickerPicture(src));
  const activeSrc = useAvatarImageFallback(src, sticker);

  if (!src || !sticker) {
    const portrait = isPersonPicture(activeSrc);
    return (
      <Avatar
        {...props}
        rounded={portrait || props.rounded}
        className={cx(props.className, portrait && "avatar-portrait")}
        alt={alt}
        src={activeSrc}
        initials={initials}
        contentClassName={
          deleted ? cx(DELETED_AVATAR_CLASS, DELETED_PICTURE_CLASS) : contentClassName
        }
      />
    );
  }
  return (
    <AvatarSticker
      size={props.size}
      className={props.className}
      contentClassName={deleted ? DELETED_PICTURE_CLASS : undefined}
      status={props.status}
      badge={props.badge}
    >
      <StickerPicture
        src={src}
        alt={alt}
        fallback={<StickerInitial initial={initials} alt={alt} />}
      />
    </AvatarSticker>
  );
}
