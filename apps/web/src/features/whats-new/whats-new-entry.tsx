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

export function useWhatsNewEntry(base?: string) {
  const { pending, dismiss } = useWhatsNew();
  const [shown, setShown] = useState<readonly WhatsNewId[] | null>(null);
  const dialog = (
    <WhatsNewDialog
      ids={shown ?? []}
      open={shown !== null}
      base={base}
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

const ANNOUNCED_KEY = "coforge-whats-new-announced";
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
    return;
  }
}

function draftFocused() {
  const field = document.activeElement as HTMLElement | null;
  if (!field || !opensKeyboard(field)) return false;
  const text = field.isContentEditable ? field.textContent : (field as HTMLInputElement).value;
  return (text ?? "").trim() !== "";
}

export function WhatsNewAnnouncer({ base }: { base?: string } = {}) {
  const entry = useWhatsNewEntry(base);
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

export function WhatsNewRow({ base }: { base?: string } = {}) {
  const entry = useWhatsNewEntry(base);
  return (
    <>
      {entry.visible && (
        <AriaButton
          onPress={entry.open}
          className="group flex h-10 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium text-nav-fg outline-focus-ring transition-colors duration-100 ease-out hover:bg-sidebar-item-active hover:text-secondary focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <Announcement02
            aria-hidden="true"
            className="size-5 shrink-0 text-nav-fg transition-colors duration-100 ease-out group-hover:text-secondary"
          />
          <span className="min-w-0 flex-1 truncate text-left">{m.whats_new_entry()}</span>
          <UnreadDot />
        </AriaButton>
      )}
      {entry.dialog}
    </>
  );
}

export function WhatsNewRailButton({ base }: { base?: string } = {}) {
  const entry = useWhatsNewEntry(base);
  return (
    <>
      {entry.visible && (
        <RailButton icon={Announcement02} label={m.whats_new_entry()} onPress={entry.open} dot />
      )}
      {entry.dialog}
    </>
  );
}
