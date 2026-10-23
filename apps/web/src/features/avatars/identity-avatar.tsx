import { Avatar, type AvatarProps } from "#src/components/base/avatar/avatar";
import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
import { personAvatarUrl } from "#src/lib/person-picture";
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
  /** Who this is: the initial shown while there is no picture, and the tone behind it, derive from
   * it. `initials` and `contentClassName` override either. */
  name?: string;
  /** A person's id: with no `src`, the face is the cartoon person this id chooses
   * (`personAvatarUrl`), the same one the server resolves. Only for a picture that can be missing
   * locally (a preview after removing the avatar); server-read pictures are never null. */
  userId?: string;
  /** Greys an archived identity: its sticker, or the base avatar's tile. */
  deleted?: boolean;
};

/**
 * The avatar of anyone shown by their picture, a person or an Agent: a platform figure (an Agent's
 * mascot or a cartoon person, `isStickerPicture`) as a sticker, anything else, an uploaded photo,
 * the base `Avatar` on a tone tile. Use it wherever a picture may be either; the base `Avatar`
 * knows nothing of stickers, so a person's face is never drawn through it directly. An Agent known
 * to be one goes through `AgentDisplayAvatar` (status dot) or `AgentMascotAvatar` (moving).
 * `status` is a member's presence dot.
 */
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
  if (!src || !isStickerPicture(src)) {
    return (
      <Avatar
        {...props}
        alt={alt}
        src={src}
        initials={initials}
        contentClassName={
          deleted ? cx(DELETED_AVATAR_CLASS, DELETED_PICTURE_CLASS) : contentClassName
        }
      />
    );
  }
  // The initials' tone (`contentClassName`) has nothing to colour on a sticker.
  return (
    <AvatarSticker
      size={props.size}
      className={props.className}
      contentClassName={deleted ? DELETED_PICTURE_CLASS : undefined}
      status={props.status}
      badge={props.badge}
    >
      <StickerPicture src={src} alt={alt} fallback={<StickerInitial initial={initials} />} />
    </AvatarSticker>
  );
}
