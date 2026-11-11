import { Fragment, type ReactNode } from "react";
import { Hash01, Lock01 } from "@untitledui/icons";
import { isPrivateChannel, type ChannelVisibility } from "./channel-visibility";
import { useChannelMembers, useChannelName } from "./channel-members";
import { GroupAvatar, type GroupAvatarMember } from "./group-avatar";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";

/** The icon a channel goes by where it has one: `#`, or a lock for a private channel, as Slack
 * marks it. */
export function channelGlyph(channel: { visibility: ChannelVisibility }) {
  return isPrivateChannel(channel) ? Lock01 : Hash01;
}

/**
 * A channel's face where it heads a page or a row (Frank, 11-10, task #74: a channel is never a
 * `#`): its group avatar, from the channel names list, at `size` (`avatar-group-xs` 20px, or none
 * for the default 48px). A channel no one is in draws `fallback` instead.
 */
export function ChannelFace({
  channelId,
  className,
  fallback,
}: {
  channelId: string;
  className?: string;
  fallback: ReactNode;
}) {
  const members = useChannelMembers({ id: channelId });
  return members?.length ? <GroupAvatar members={members} className={className} /> : fallback;
}

/** The lock before a private channel's name, read out as "Private". */
function ChannelLock({ className }: { className?: string }) {
  return (
    <Lock01
      role="img"
      // The icon set hides its glyphs from assistive tech; this one says the channel is private.
      aria-hidden={false}
      aria-label={m.channel_private()}
      className={cx("shrink-0", className)}
    />
  );
}

/**
 * A channel's name as a title shows it: `#name`, or for a private channel a lock before the bare
 * name. `hash={false}` is a list's form, whose public name goes without `#`. Where only text fits,
 * `channelLabel`.
 */
export function ChannelTitle({
  name,
  visibility,
  hash = true,
  lockClassName = "size-4",
}: {
  name: string;
  visibility: ChannelVisibility;
  hash?: boolean;
  lockClassName?: string;
}) {
  if (!isPrivateChannel({ visibility })) return hash ? `#${name}` : name;
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1 align-bottom">
      <ChannelLock className={lockClassName} />
      <span className="truncate">{name}</span>
    </span>
  );
}

/**
 * A channel named in a line beside other text (a search result's or a saved message's place): its
 * group avatar at 20px, then its name with no `#` (Frank, 11-10: a channel is never a `#`, task
 * #55); a private one keeps its lock. A channel no one is in reads its name alone. Sentences keep
 * `#name` (`withChannelTitle`).
 */
export function ChannelPlace({
  id,
  name,
  visibility,
  members,
}: {
  id: string;
  name: string;
  /** When the caller's data lacks it, the channel names' say. */
  visibility?: ChannelVisibility;
  /** Its members from the caller's own server read, for a page rendered on the server, where the
   * channel names are not read; else the channel names'. */
  members?: readonly GroupAvatarMember[];
}) {
  const listed = useChannelName({ id });
  const faces = members ?? listed?.members;
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1.5 align-bottom">
      {faces?.length ? <GroupAvatar members={faces} className="avatar-group-xs" /> : null}
      <span data-channel-name="" className="min-w-0 truncate">
        <ChannelTitle
          name={name}
          visibility={visibility ?? listed?.visibility ?? "public"}
          hash={false}
          lockClassName="size-3.5"
        />
      </span>
    </span>
  );
}

/** Stands in for the channel while a sentence is written, then marks where its title goes. */
const CHANNEL_SLOT = "\u2063";

/**
 * A sentence that names a channel, with the channel as `ChannelTitle` shows it (a private one with
 * its lock) wherever the sentence puts it: `sentence` writes the words around it.
 */
export function withChannelTitle(
  sentence: (channel: string) => string,
  channel: { name: string; visibility: ChannelVisibility },
): ReactNode {
  const parts = sentence(CHANNEL_SLOT).split(CHANNEL_SLOT);
  return parts.map((part, index) => (
    <Fragment key={index}>
      {part}
      {index < parts.length - 1 && <ChannelTitle {...channel} lockClassName="size-3.5" />}
    </Fragment>
  ));
}
