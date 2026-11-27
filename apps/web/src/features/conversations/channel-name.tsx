import { createContext, Fragment, useContext, type ComponentProps, type ReactNode } from "react";
import { Hash01, Lock01 } from "@untitledui/icons";
import { isPrivateChannel, type ChannelVisibility } from "./channel-visibility";
import {
  useChannelMembers,
  useChannelName,
  useChannelNamesIndex,
  type ChannelNamesIndex,
} from "./channel-members";
import { GroupAvatar, type GroupAvatarMember } from "./group-avatar";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";

const ChannelNamesIndexContext = createContext<ChannelNamesIndex | undefined>(undefined);

export function ChannelNamesIndexProvider({ children }: { children: ReactNode }) {
  const index = useChannelNamesIndex();
  return <ChannelNamesIndexContext value={index}>{children}</ChannelNamesIndexContext>;
}

/** The icon a channel goes by where it has one: `#`, or a lock for a private channel, as Slack
 * marks it. */
export function channelGlyph(channel: { visibility: ChannelVisibility }) {
  return isPrivateChannel(channel) ? Lock01 : Hash01;
}

export function ChannelGlyph({
  visibility,
  ...props
}: { visibility: ChannelVisibility } & ComponentProps<typeof Hash01>) {
  return isPrivateChannel({ visibility }) ? <Lock01 {...props} /> : <Hash01 {...props} />;
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

type ChannelPlaceProps = {
  id?: string;
  name: string;
  visibility?: ChannelVisibility;
  members?: readonly GroupAvatarMember[];
};

export function ChannelPlace(props: ChannelPlaceProps) {
  const index = useContext(ChannelNamesIndexContext);
  if (index !== undefined) {
    const listed = props.id ? index.byId.get(props.id) : index.byName.get(props.name);
    return (
      <ChannelPlaceView
        name={props.name}
        visibility={props.visibility ?? listed?.visibility ?? "public"}
        faces={props.members ?? listed?.members}
      />
    );
  }
  return <ChannelPlaceWithQuery {...props} />;
}

function ChannelPlaceWithQuery({ id, name, visibility, members }: ChannelPlaceProps) {
  const listed = useChannelName(id ? { id } : { name });
  return (
    <ChannelPlaceView
      name={name}
      visibility={visibility ?? listed?.visibility ?? "public"}
      faces={members ?? listed?.members}
    />
  );
}

function ChannelPlaceView({
  name,
  visibility,
  faces,
}: {
  name: string;
  visibility: ChannelVisibility;
  faces: readonly GroupAvatarMember[] | undefined;
}) {
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1.5 align-bottom">
      {faces?.length ? <GroupAvatar members={faces} className="avatar-group-xs" /> : null}
      <span data-channel-name="" className="min-w-0 truncate">
        <ChannelTitle name={name} visibility={visibility} hash={false} lockClassName="size-3.5" />
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
