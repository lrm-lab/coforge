import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight } from "@untitledui/icons";

import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { TerminalCommand } from "./terminal-command";

export function ComputerDetailAdvanced({
  autoOpen,
  workspaceSlug,
  showTerminal,
  workspaceInventory,
}: {
  autoOpen: boolean;
  workspaceSlug: string;
  showTerminal: boolean;
  workspaceInventory?: ReactNode;
}) {
  const [disclosure, setDisclosure] = useState(() => ({ open: autoOpen, auto: autoOpen }));

  useEffect(() => {
    if (!autoOpen) return;
    setDisclosure((prev) => (prev.open ? prev : { open: true, auto: true }));
  }, [autoOpen]);

  const hasWorkspaceInventory = Boolean(workspaceInventory);
  if (!hasWorkspaceInventory && !showTerminal) return null;

  const summaryHint =
    disclosure.open && disclosure.auto && autoOpen
      ? m.computer_detail_advanced_auto_opened()
      : hasWorkspaceInventory && showTerminal
        ? m.computer_detail_advanced_hint()
        : hasWorkspaceInventory
          ? m.computer_detail_advanced_hint_cleanup()
          : m.computer_detail_advanced_hint_terminal();

  return (
    <details
      open={disclosure.open}
      onToggle={(event) => {
        const nextOpen = event.currentTarget.open;
        setDisclosure((prev) => ({
          open: nextOpen,
          auto: nextOpen ? prev.auto : false,
        }));
      }}
      className="group px-page"
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 py-3 text-xs font-medium text-secondary transition-colors outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-brand [&::-webkit-details-marker]:hidden">
        <span className="inline-flex items-center gap-1.5">
          <ChevronRight
            aria-hidden="true"
            className="size-3.5 text-fg-quaternary transition-transform duration-(--duration-sm) ease-in-out group-open:rotate-90 rtl:rotate-180 rtl:group-open:rotate-90 motion-reduce:transition-none"
          />
          <span>{m.computer_detail_advanced_section()}</span>
        </span>
        <span className="truncate font-normal text-quaternary">{summaryHint}</span>
      </summary>

      <div className="space-y-4 pb-5">
        {hasWorkspaceInventory ? <div>{workspaceInventory}</div> : null}

        {showTerminal ? (
          <div
            className={cn("space-y-2.5", hasWorkspaceInventory && "border-t border-secondary pt-4")}
          >
            <div>
              <h3 className="text-xs font-semibold text-primary">
                {m.computer_troubleshoot_terminal()}
              </h3>
              <p className="mt-0.5 text-xs text-tertiary">
                {m.computer_verify_terminal_description()}
              </p>
            </div>
            <div className="space-y-2">
              <TerminalCommand command="coforge-computer status" />
              <TerminalCommand command="coforge-computer logs" />
            </div>
            <p className="pt-1 text-xs text-tertiary">{m.computer_restart_from_terminal()}</p>
            <TerminalCommand command={`coforge-computer restart --workspace ${workspaceSlug}`} />
          </div>
        ) : null}
      </div>
    </details>
  );
}
