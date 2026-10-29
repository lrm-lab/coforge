import { Bookmark, Check } from "@untitledui/icons";
import { BadgeWithIcon } from "#src/components/base/badges/badges";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { ReadState } from "./conversation-pane-layout";

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

/**
 * An own message's ticks where they sit: right after the last word of its text (`inline`, as on a
 * Telegram bubble), or at the message's bottom right when it has no text to follow (an image on
 * its own, an action card). Only the newest own message shows them outright (Frank); the others on
 * a desktop hover or focus, the same gate as the action toolbar.
 */
export function OwnMessageTicks({ readState, inline }: { readState: ReadState; inline: boolean }) {
  return (
    <span
      data-read-ticks={inline ? "inline" : readState.latest ? "latest" : "hover"}
      className={cn(
        inline ? "ml-1.5 inline-flex align-[-2px]" : "absolute right-0 bottom-0 flex",
        !readState.latest &&
          "hidden lg:[@media(hover:hover)_and_(pointer:fine)]:opacity-0 lg:[@media(hover:hover)_and_(pointer:fine)]:group-focus-within/message:opacity-100 lg:[@media(hover:hover)_and_(pointer:fine)]:group-hover/message:opacity-100",
        !readState.latest &&
          (inline
            ? "lg:[@media(hover:hover)_and_(pointer:fine)]:inline-flex"
            : "lg:[@media(hover:hover)_and_(pointer:fine)]:flex"),
      )}
    >
      <ReadTicks state={readState.read ? "read" : "sent"} />
    </span>
  );
}
