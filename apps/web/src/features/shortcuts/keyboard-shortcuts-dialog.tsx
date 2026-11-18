import { Fragment } from "react";
import { Heading } from "react-aria-components";

import { CloseButton } from "#src/components/base/buttons/close-button";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { SEARCH_KEY } from "#src/features/search/search-key-hints";
import { hotkeyKeycaps } from "#src/lib/hotkeys";
import { isApplePlatform } from "#src/lib/platform";
import { m } from "#src/paraglide/messages";
import { SHORTCUT_GROUPS } from "./keyboard-shortcuts";

function Keys({ hotkeys, apple }: { hotkeys: readonly string[]; apple: boolean }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {hotkeys.map((hotkey, index) => (
        <Fragment key={hotkey}>
          {index > 0 && (
            <span className="px-0.5 text-xs text-quaternary">
              <span aria-hidden="true">/</span>
              <span className="sr-only">{m.shortcuts_or()}</span>
            </span>
          )}
          <kbd data-hotkey={hotkey} className="flex items-center gap-0.5">
            {hotkeyKeycaps(hotkey, apple).map((cap, capIndex) => (
              <span key={capIndex} className={SEARCH_KEY}>
                {cap}
              </span>
            ))}
          </kbd>
        </Fragment>
      ))}
    </span>
  );
}

export function KeyboardShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const apple = typeof navigator !== "undefined" && isApplePlatform();
  return (
    <ModalOverlay isOpen={open} onOpenChange={onOpenChange} isDismissable>
      <Modal className="w-[calc(100vw-2rem)] max-w-lg">
        <Dialog className="text-left" data-keyboard-shortcuts>
          <>
            <div className="flex items-center justify-between gap-4 px-6 pt-5 pb-3">
              <Heading slot="title" className="text-lg font-semibold text-primary">
                {m.shortcuts_title()}
              </Heading>
              <CloseButton size="sm" label={m.controls_close()} />
            </div>
            <div className="max-h-[70vh] overflow-y-auto px-6 pb-6">
              {SHORTCUT_GROUPS.map((group) => (
                <section key={group.title()} className="mt-3 first:mt-0">
                  <h3 className="py-1.5 text-xs font-medium text-tertiary">{group.title()}</h3>
                  <ul>
                    {group.rows.map((row) => (
                      <li
                        key={row.label()}
                        className="flex min-h-8 items-center justify-between gap-4 py-1"
                      >
                        <span className="text-sm text-secondary">{row.label()}</span>
                        <Keys hotkeys={row.keys} apple={apple} />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
