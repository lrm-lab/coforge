import { AtSign } from "@untitledui/icons";

/** The "@" icon marker of a channel row whose unread messages or unread followed threads mention
 * the viewer (shown even when the channel is muted; never on DM rows). */
export function MentionBadge() {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-unread-capsule-muted text-primary"
    >
      <AtSign aria-hidden="true" className="size-3 [stroke-width:2.25]" />
    </span>
  );
}
