import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
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

const CIRCLE_CLASS = "absolute overflow-hidden rounded-full";
/** A mascot is drawn whole on its own: no circle clipping it and no separator ring around it. */
const MASCOT_CLASS = "absolute";
/** The separator between overlapping circles; a lone member fills the frame and needs none. */
const SEPARATOR_CLASS = "ring-2 ring-bg-primary";

/**
 * A channel's group avatar: up to four overlapping member circles laid out by `collageLayout`
 * inside a round frame (`.avatar-group` in `styles.css` sets its size and frame). Above four
 * members the fourth circle is a "…". Decorative: the row's label names the channel.
 */
export function GroupAvatar({
  members,
  className,
}: {
  members: readonly GroupAvatarMember[];
  className?: string;
}) {
  return (
    <span aria-hidden="true" className={cx("avatar-group", className)}>
      {collageLayout(members.length).map((placed, index) => {
        if (placed.overflow) {
          return (
            <span
              key="overflow"
              className={cx(
                CIRCLE_CLASS,
                SEPARATOR_CLASS,
                "flex items-center justify-center bg-tertiary font-semibold text-tertiary",
              )}
              style={placed.css}
            >
              …
            </span>
          );
        }
        // A non-overflow slot exists only for a member at its index.
        const member = members[index]!;
        if (isMascotPicture(member.avatarUrl)) {
          return (
            <span key={member.id} className={MASCOT_CLASS} style={placed.css}>
              <img
                src={member.avatarUrl!}
                alt=""
                loading="lazy"
                className="size-full object-contain"
              />
            </span>
          );
        }
        return (
          <span
            key={member.id}
            className={cx(CIRCLE_CLASS, placed.size < 1 && SEPARATOR_CLASS)}
            style={placed.css}
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
                  "flex size-full items-center justify-center font-semibold",
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
  );
}
