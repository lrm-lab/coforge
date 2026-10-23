import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
import {
  AvatarSticker,
  StickerInitial,
  StickerPicture,
} from "#src/features/avatars/avatar-sticker";
import { isStickerPicture } from "#src/features/avatars/sticker-picture";
import { cx } from "#src/utils/cx";
import { collageLayout } from "./collage-layout";

/** One member a channel's group avatar shows: its picture (an Agent's mascot or a person's cartoon, whole; an uploaded photo, round), or its initial when it has none. */
export type GroupAvatarMember = {
  kind: "user" | "agent";
  id: string;
  name: string;
  avatarUrl: string | null;
};

/**
 * A channel's group avatar: up to four overlapping member stickers laid out by `collageLayout` on
 * a box with no fill (`.avatar-group` in `styles.css` sets its size). An Agent is its
 * white-edged mascot, unclipped, and so is a person's cartoon (`isStickerPicture`); a person who
 * uploaded a photo is that round photo (or their initial) with a white sticker edge
 * (`.avatar-group-photo`); above four members the fourth sticker is a "…". A lone member is drawn
 * like a single avatar: a sticker as an `AvatarSticker`, a photo filling the circle.
 * Decorative: the row's label names the channel.
 */
export function GroupAvatar({
  members,
  className,
}: {
  members: readonly GroupAvatarMember[];
  className?: string;
}) {
  const alone = members.length === 1;
  return (
    <span aria-hidden="true" className={cx("avatar-group", className)}>
      {collageLayout(members.length).map((placed, index) => {
        if (placed.overflow) {
          return (
            <span key="overflow" className="absolute" style={placed.css}>
              <span className="avatar-group-photo flex items-center justify-center bg-tertiary font-semibold text-tertiary">
                …
              </span>
            </span>
          );
        }
        // A non-overflow slot exists only for a member at its index.
        const member = members[index]!;
        return (
          <span key={member.id} className="absolute" style={placed.css}>
            <MemberFace member={member} alone={alone} />
          </span>
        );
      })}
    </span>
  );
}

/** One member in its slot: a sticker picture is the shared sticker (a lone member on a full
 * `AvatarSticker`, one of several placed in the group); an uploaded photo or the initial on a
 * tone is a round face with the white sticker edge, or filling the circle when alone. */
function MemberFace({ member, alone }: { member: GroupAvatarMember; alone: boolean }) {
  const initial = avatarInitial(member.name);
  if (isStickerPicture(member.avatarUrl)) {
    return alone ? (
      <AvatarSticker size="fill">
        <StickerPicture src={member.avatarUrl!} fallback={<StickerInitial initial={initial} />} />
      </AvatarSticker>
    ) : (
      // A sticker that cannot load falls back to its initial on a round sticker.
      <StickerPicture
        src={member.avatarUrl!}
        fallback={
          <span className="avatar-group-photo flex items-center justify-center bg-tertiary font-semibold text-tertiary">
            {initial}
          </span>
        }
      />
    );
  }
  const face = member.avatarUrl ? (
    <img src={member.avatarUrl} alt="" loading="lazy" className="size-full object-cover" />
  ) : (
    <span
      className={cx(
        "flex size-full items-center justify-center font-semibold",
        avatarToneClassName(member.name),
      )}
    >
      {initial}
    </span>
  );
  return alone ? (
    <span className="absolute inset-0 overflow-hidden rounded-full">{face}</span>
  ) : (
    <span className="avatar-group-photo">{face}</span>
  );
}
