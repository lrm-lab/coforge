import { DotsHorizontal } from "@untitledui/icons";
import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
import {
  AvatarSticker,
  StickerInitial,
  StickerPicture,
} from "#src/features/avatars/avatar-sticker";
import { isStickerPicture } from "#src/features/avatars/sticker-picture";
import { cx } from "#src/utils/cx";
import { collageLayout } from "./collage-layout";

export type GroupAvatarMember = {
  kind: "user" | "agent";
  id: string;
  name: string;
  avatarUrl: string | null;
};

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
              <span className="avatar-group-photo flex items-center justify-center bg-tertiary text-tertiary">
                <DotsHorizontal aria-hidden="true" className="size-3/4" />
              </span>
            </span>
          );
        }
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

function MemberFace({ member, alone }: { member: GroupAvatarMember; alone: boolean }) {
  const initial = avatarInitial(member.name);
  if (isStickerPicture(member.avatarUrl)) {
    return alone ? (
      <AvatarSticker size="fill">
        <StickerPicture src={member.avatarUrl!} fallback={<StickerInitial initial={initial} />} />
      </AvatarSticker>
    ) : (
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
