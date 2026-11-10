import { useState } from "react";
import { Button as AriaButton } from "react-aria-components";
import { Announcement02 } from "@untitledui/icons";
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { UnreadDot } from "#src/components/ui/unread-marker";
import { m } from "#src/paraglide/messages";
import { useWhatsNew } from "./use-whats-new";
import { WhatsNewDialog } from "./whats-new-dialog";
import type { WhatsNewId } from "./whats-new-entries";

/**
 * "What's new" (task #516): a row with a dot, only while entries wait (task #585). It opens the
 * dialog on them; whatever was reached is then seen, and once nothing waits the row goes until the
 * next release. The sidebar draws the row (`WhatsNewRow`, `WhatsNewRailButton`) and so does the
 * Me page, from the same state.
 */
export function useWhatsNewEntry() {
  const { pending, dismiss } = useWhatsNew();
  // What the dialog pages through stays as it was when it opened.
  const [shown, setShown] = useState<readonly WhatsNewId[] | null>(null);
  const dialog = (
    <WhatsNewDialog
      ids={shown ?? []}
      open={shown !== null}
      onClose={(seen) => {
        dismiss(seen.filter((id) => pending.includes(id)));
        setShown(null);
      }}
    />
  );
  return {
    visible: pending.length > 0,
    open: () => setShown(pending),
    dialog,
  };
}

/** The row at the foot of the expanded sidebar. */
export function WhatsNewRow() {
  const entry = useWhatsNewEntry();
  // The dialog stays mounted, so it closes in place once the row goes with the last entry.
  return (
    <>
      {entry.visible && (
        <AriaButton
          onPress={entry.open}
          className="group mb-0.5 flex h-10 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium text-nav-fg outline-focus-ring transition-colors duration-100 ease-linear hover:bg-sidebar-item-active hover:text-secondary focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <Announcement02
            aria-hidden="true"
            className="size-5 shrink-0 text-nav-fg transition-colors duration-100 ease-linear group-hover:text-secondary"
          />
          <span className="min-w-0 flex-1 truncate text-left">{m.whats_new_entry()}</span>
          <UnreadDot />
        </AriaButton>
      )}
      {entry.dialog}
    </>
  );
}

/** The same entry in the collapsed rail: the icon, named by its tooltip. */
export function WhatsNewRailButton() {
  const entry = useWhatsNewEntry();
  return (
    <>
      {entry.visible && (
        <Tooltip title={m.whats_new_entry()} placement="right" offset={4}>
          <AriaButton
            onPress={entry.open}
            aria-label={m.whats_new_entry()}
            className="group mx-auto flex size-11 items-center justify-center rounded-lg outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            <span className="relative flex size-10 items-center justify-center rounded-lg transition-colors duration-100 ease-linear group-hover:bg-sidebar-accent">
              <Announcement02
                aria-hidden="true"
                className="size-5 stroke-[2.4] text-nav-fg transition-colors duration-100 ease-linear group-hover:text-secondary"
              />
              <UnreadDot className="absolute top-1.5 right-1.5" />
            </span>
          </AriaButton>
        </Tooltip>
      )}
      {entry.dialog}
    </>
  );
}
