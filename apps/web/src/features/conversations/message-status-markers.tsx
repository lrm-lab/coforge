import { Bookmark, Check } from "@untitledui/icons";
import { BadgeWithIcon } from "#src/components/base/badges/badges";
import { m } from "#src/paraglide/messages";

export function SavedMessageMarker() {
  return (
    <div className="flex pt-0.5">
      <BadgeWithIcon type="color" color="brand" size="sm" iconLeading={Bookmark}>
        {m.conversation_saved_marker()}
      </BadgeWithIcon>
    </div>
  );
}

/**
 * Telegram's ticks on an own message: one once it is sent, two once another member has read it.
 * Both in the time's colour, told apart by count alone; two overlapping checks, since the icon set
 * has no double check.
 */
export function ReadTicks({ state }: { state: "sent" | "read" }) {
  return (
    <span
      role="img"
      aria-label={state === "read" ? m.conversation_read() : m.conversation_sent()}
      data-read-state={state}
      className="flex items-center text-tertiary"
    >
      <Check aria-hidden="true" className="size-3.5" />
      {state === "read" && <Check aria-hidden="true" className="-ml-2 size-3.5" />}
    </span>
  );
}
