import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
import { AvatarSticker, StickerInitial, StickerPicture } from "#src/features/agents/avatar-sticker";
import { isMascotPicture } from "#src/features/agents/mascot-contract";
import { cx } from "#src/utils/cx";
import { collageLayout } from "./collage-layout";

/** One member a channel's group avatar shows: its photo (an Agent's mascot, whole), or its initial when it has none. */
export type GroupAvatarMember = {
  kind: "user" | "agent";
  id: string;
  name: string;
  avatarUrl: string | null;
};

/**
 * A channel's group avatar: up to four overlapping member stickers laid out by `collageLayout` on
 * a round backdrop (`.avatar-group` in `styles.css` sets its size and colour). An Agent is its
 * white-edged mascot, unclipped; a person is their round photo (or initial) with a white sticker
 * edge (`.avatar-group-photo`); above four members the fourth sticker is a "…". A lone member is
 * drawn like a single avatar: a mascot as an `AvatarSticker`, a photo filling the circle.
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
        if (isMascotPicture(member.avatarUrl)) {
          const initial = avatarInitial(member.name);
          return (
            <span key={member.id} className="absolute" style={placed.css}>
              {alone ? (
                <AvatarSticker size="fill">
                  <StickerPicture
                    src={member.avatarUrl!}
                    fallback={<StickerInitial initial={initial} />}
                  />
                </AvatarSticker>
              ) : (
                // A mascot that cannot load falls back to its initial on a round sticker.
                <StickerPicture
                  src={member.avatarUrl!}
                  fallback={
                    <span className="avatar-group-photo flex items-center justify-center bg-tertiary font-semibold text-tertiary">
                      {initial}
                    </span>
                  }
                />
              )}
            </span>
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
            {avatarInitial(member.name)}
          </span>
        );
        return (
          <span key={member.id} className="absolute" style={placed.css}>
            {alone ? (
              <span className="absolute inset-0 overflow-hidden rounded-full">{face}</span>
            ) : (
              <span className="avatar-group-photo">{face}</span>
            )}
          </span>
        );
      })}
    </span>
  );
}
