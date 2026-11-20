import { useEffect, useEffectEvent, useState } from "react";
import { Button as AriaButton } from "react-aria-components";
import { Announcement02 } from "@untitledui/icons";
import { RailButton } from "#src/components/layout/sidebar/sidebar-rail";
import { opensKeyboard } from "#src/hooks/use-keyboard-field-focused";
import { UnreadDot } from "#src/components/ui/unread-marker";
import { m } from "#src/paraglide/messages";
import { useWhatsNew } from "./use-whats-new";
import { WHATS_NEW_CONTENT } from "./whats-new-content";
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
  const featuredId = entry.pending.at(-1);
  const featured = featuredId ? WHATS_NEW_CONTENT[featuredId] : null;
  const Thumb = featured?.thumbnail;
  return (
    <>
      {entry.visible && featured && Thumb && (
        <div className="relative pt-4 pb-1">
          <img
            src="/agent-avatars/mascot-purple-5.webp"
            alt=""
            aria-hidden="true"
            decoding="async"
            className="wna-thumb-mascot pointer-events-none absolute -top-0.5 right-3 z-10 size-9 -rotate-6 object-contain"
          />
          <AriaButton
            onPress={entry.open}
            aria-label={m.whats_new_entry()}
            className="group relative flex w-full cursor-pointer flex-col rounded-xl bg-primary p-2.5 text-left ring-1 ring-secondary outline-focus-ring transition-colors duration-150 ease-out hover:bg-primary_hover focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            <span className="flex items-center gap-1.5 text-[0.6875rem] font-semibold tracking-wider text-quaternary uppercase">
              <UnreadDot />
              <span className="truncate">{m.whats_new_entry()}</span>
            </span>
            <div
              aria-hidden="true"
              className="mt-2 h-16 w-full overflow-hidden rounded-lg ring-1 ring-secondary ring-inset"
            >
              <Thumb />
            </div>
            <span className="mt-2 block truncate text-xs font-semibold text-primary">
              {featured.title()}
            </span>
            <span className="mt-0.5 line-clamp-2 text-xs text-tertiary">{featured.teaser()}</span>
          </AriaButton>
        </div>
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
