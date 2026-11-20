import { useMemo } from "react";
import { Settings01 } from "@untitledui/icons";
import { useNavigate } from "@tanstack/react-router";
import { Heading } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { CloseButton } from "#src/components/base/buttons/close-button";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { isApplePlatform } from "#src/lib/platform";
import { m } from "#src/paraglide/messages";
import {
  resolveShortcutGroups,
  SHORTCUT_MODAL_COLUMNS,
  type ShortcutGroup,
  type ShortcutGroupId,
} from "./keyboard-shortcuts";
import { useAllShortcutBindings } from "./shortcut-bindings";
import { ShortcutKeycaps } from "./shortcut-keycaps";

export function KeyboardShortcutsDialog({
  open,
  onOpenChange,
  workspaceSlug,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceSlug?: string;
}) {
  const navigate = useNavigate();
  const bindings = useAllShortcutBindings();
  const apple = typeof navigator !== "undefined" && isApplePlatform();

  const groupMap = useMemo(() => {
    const groups = resolveShortcutGroups(bindings);
    return new Map<ShortcutGroupId, ShortcutGroup>(groups.map((group) => [group.id, group]));
  }, [bindings]);

  function openSettings() {
    onOpenChange(false);
    if (!workspaceSlug) return;
    void navigate({
      to: "/w/$workspaceSlug/settings",
      params: { workspaceSlug },
      search: { section: "shortcuts" },
    });
  }

  return (
    <ModalOverlay isOpen={open} onOpenChange={onOpenChange} isDismissable instant>
      <Modal className="w-[calc(100vw-2rem)] max-w-[68rem]">
        <Dialog className="text-left" data-keyboard-shortcuts>
          <>
            <div className="flex items-center justify-between gap-3 border-b border-secondary px-5 pt-4 pb-3.5 sm:px-6 sm:pt-5 sm:pb-4">
              <Heading slot="title" className="min-w-0 truncate text-lg font-semibold text-primary">
                {m.shortcuts_title()}
              </Heading>
              <div className="flex shrink-0 items-center gap-2">
                {workspaceSlug && (
                  <Button
                    type="button"
                    color="secondary"
                    size="sm"
                    iconLeading={Settings01}
                    onPress={openSettings}
                  >
                    {m.shortcuts_configure()}
                  </Button>
                )}
                <CloseButton size="sm" label={m.controls_close()} />
              </div>
            </div>
            <div className="max-h-[min(78vh,46rem)] overflow-y-auto px-5 py-5 sm:px-6">
              <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3 lg:gap-8">
                {SHORTCUT_MODAL_COLUMNS.map((columnGroupIds, columnIndex) => (
                  <div key={columnIndex} className="min-w-0 space-y-6">
                    {columnGroupIds.map((groupId) => {
                      const group = groupMap.get(groupId);
                      if (!group) return null;
                      return (
                        <section key={group.id} className="min-w-0">
                          <h3 className="border-b border-secondary pb-1.5 text-xs font-semibold text-tertiary">
                            {group.title()}
                          </h3>
                          <ul className="mt-1.5 space-y-0.5">
                            {group.rows.map((row) => (
                              <li
                                key={row.label()}
                                className="flex min-h-8 items-center justify-between gap-3 py-1"
                              >
                                <span className="min-w-0 text-sm text-secondary">
                                  {row.label()}
                                </span>
                                <ShortcutKeycaps hotkeys={row.keys} apple={apple} />
                              </li>
                            ))}
                          </ul>
                        </section>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
