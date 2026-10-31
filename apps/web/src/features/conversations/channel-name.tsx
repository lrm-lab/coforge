import { Hash01, Lock01 } from "@untitledui/icons";
import { isPrivateChannel, type ChannelVisibility } from "./channel-visibility";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";

/** The icon a channel goes by where it has one: `#`, or a lock for a private channel, as Slack
 * marks it. */
export function channelGlyph(channel: { visibility: ChannelVisibility }) {
  return isPrivateChannel(channel) ? Lock01 : Hash01;
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
