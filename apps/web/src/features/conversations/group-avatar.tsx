import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
import { cx } from "#src/utils/cx";
import { collageLayout } from "./collage-layout";

/** One member a channel's collage shows: its photo, or its initial when it has none. */
export type GroupAvatarMember = {
  kind: "user" | "agent";
  id: string;
  name: string;
  avatarUrl: string | null;
};

/**
 * A channel's collage avatar: up to six member avatars laid out by `collageLayout`, in the same
 * rounded frame as a direct message's avatar (`.avatar-group` in `styles.css` sets its size and
 * frame). Decorative: the row's label names the channel.
 */
export function GroupAvatar({
  members,
  className,
}: {
  members: readonly GroupAvatarMember[];
  className?: string;
}) {
  const tiles = collageLayout(members.length);
  return (
    <span aria-hidden="true" className={cx("avatar-group", className)}>
      <span className="avatar-group-grid">
        {members.slice(0, tiles.length).map((member, index) => {
          const tile = tiles[index]!;
          return (
            <span
              key={member.id}
              className="relative min-h-0 min-w-0 overflow-hidden"
              style={{
                gridRow: `${tile.row[0]} / ${tile.row[1]}`,
                gridColumn: `${tile.column[0]} / ${tile.column[1]}`,
              }}
            >
              {member.avatarUrl ? (
                <img
                  src={member.avatarUrl}
                  alt=""
                  loading="lazy"
                  className="size-full object-cover"
                />
              ) : (
                <span
                  className={cx(
                    "flex size-full items-center justify-center text-xs font-semibold",
                    avatarToneClassName(member.name),
                  )}
                >
                  {avatarInitial(member.name)}
                </span>
              )}
            </span>
          );
        })}
      </span>
    </span>
  );
}
