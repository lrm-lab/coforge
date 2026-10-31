import { Lock01 } from "@untitledui/icons";
import type { ChannelVisibility } from "./channel-visibility";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";

/** Whether a channel is private; absent (a row read before private channels) is public. */
export function isPrivateChannel(channel: { visibility?: ChannelVisibility }) {
  return channel.visibility === "private";
}

/** The lock that marks a private channel where a public one shows `#`, as Slack marks it. */
export function ChannelLock({ className }: { className?: string }) {
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
 * name. `hash={false}` is a list's form, whose public name goes without `#`. Plain-text places (a
 * pane's name, search, chips) keep `#name` for both.
 */
export function ChannelName({
  name,
  visibility,
  hash = true,
  lockClassName = "size-4",
}: {
  name: string;
  visibility?: ChannelVisibility;
  hash?: boolean;
  lockClassName?: string;
}) {
  if (visibility !== "private") return hash ? `#${name}` : name;
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1 align-bottom">
      <ChannelLock className={lockClassName} />
      <span className="truncate">{name}</span>
    </span>
  );
}
