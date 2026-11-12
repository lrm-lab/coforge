import { useEffect, useEffectEvent, useState } from "react";
import { Button as AriaButton } from "react-aria-components";
import { Announcement02 } from "@untitledui/icons";
import { RailButton } from "#src/components/layout/sidebar/sidebar-rail";
import { opensKeyboard } from "#src/hooks/use-keyboard-field-focused";
import { UnreadDot } from "#src/components/ui/unread-marker";
import { m } from "#src/paraglide/messages";
import { useWhatsNew } from "./use-whats-new";
import { WhatsNewDialog } from "./whats-new-dialog";
import { announcedWhatsNew, WHATS_NEW_ENTRIES, type WhatsNewId } from "./whats-new-entries";

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
    pending,
    visible: pending.length > 0,
    open: () => setShown(pending),
    openOn: setShown,
    dialog,
  };
}

/** Where this browser keeps the entries it has opened unasked. */
const ANNOUNCED_KEY = "coforge-whats-new-announced";
/** How long the keyboard has to rest before an entry opens by itself. */
const QUIET_MS = 3000;

function readAnnounced(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(ANNOUNCED_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writeAnnounced(ids: readonly string[]) {
  try {
    localStorage.setItem(ANNOUNCED_KEY, JSON.stringify(ids));
  } catch {
    // Private mode or full storage: it may open once more on the next visit.
  }
}

/** Whether the focused field holds something being written, which a dialog would interrupt. */
function draftFocused() {
  const field = document.activeElement as HTMLElement | null;
  if (!field || !opensKeyboard(field)) return false;
  const text = field.isContentEditable ? field.textContent : (field as HTMLInputElement).value;
  return (text ?? "").trim() !== "";
}

/**
 * Opens the entries marked `announce` once, by themselves (Frank, 11-12: few people press the row
 * unasked), at a calm moment: the tab is in view, the keyboard has rested a while, no focused field
 * holds a draft and no other dialog is up.
 * This browser remembers them, so a reload does not reopen one. Closing it marks what was reached
 * seen, as from the row; whatever it did not reach keeps the row. Mounted once, by the shell.
 */
export function WhatsNewAnnouncer() {
  const entry = useWhatsNewEntry();
  const due = useEffectEvent(() =>
    announcedWhatsNew(WHATS_NEW_ENTRIES, entry.pending, readAnnounced()),
  );
  const announce = useEffectEvent(() => {
    const ids = due();
    if (ids.length === 0) return;
    writeAnnounced([...readAnnounced(), ...ids]);
    entry.openOn(ids);
  });
  const pendingKey = entry.pending.join(" ");
  useEffect(() => {
    // Nothing to open by itself, so nothing to wait for.
    if (!pendingKey || due().length === 0) return;
    let lastKey = Date.now();
    const onKey = () => {
      lastKey = Date.now();
    };
    document.addEventListener("keydown", onKey, true);
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible" || Date.now() - lastKey < QUIET_MS) return;
      if (draftFocused() || document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      announce();
      clearInterval(timer);
      document.removeEventListener("keydown", onKey, true);
    }, 1000);
    return () => {
      clearInterval(timer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [pendingKey]);
  return entry.dialog;
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
          className="group flex h-10 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium text-nav-fg outline-focus-ring transition-colors duration-100 ease-linear hover:bg-sidebar-item-active hover:text-secondary focus-visible:outline-2 focus-visible:outline-offset-2"
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
        <RailButton icon={Announcement02} label={m.whats_new_entry()} onPress={entry.open} dot />
      )}
      {entry.dialog}
    </>
  );
}
