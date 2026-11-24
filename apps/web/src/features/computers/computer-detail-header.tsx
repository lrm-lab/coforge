import type { ReactNode } from "react";

import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { StatusDot } from "#src/components/ui/status-dot";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { BackToComputers, ComputerDetailPaneActions } from "./back-to-computers";
import { ComputerDetailInlineTitle } from "./computer-detail-title";
import type { ComputerDetailView } from "./computer-detail-view";
import { computerIcon } from "./computer-identity";

export function ComputerDetailHeader({
  computer,
  title,
  onUpdateDisplayName,
  menu,
}: {
  computer: ComputerDetailView;
  title: string;
  onUpdateDisplayName?: (displayName: string) => Promise<void>;
  menu?: ReactNode;
}) {
  const Icon = computerIcon(computer);
  const statusLabel = computer.online ? m.computer_status_online() : m.computer_status_offline();

  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-secondary px-page">
      <BackToComputers />
      <Tooltip title={statusLabel}>
        <TooltipTrigger
          aria-label={statusLabel}
          className="relative flex shrink-0 rounded-lg outline-focus-ring focus-visible:outline-2"
        >
          <span
            aria-hidden="true"
            className={cn(
              "flex size-7 items-center justify-center rounded-lg border border-secondary bg-secondary",
              computer.online ? "text-secondary" : "text-quaternary opacity-80",
            )}
          >
            <Icon className="size-3.5" />
          </span>
          <StatusDot
            tone={computer.online ? "online" : "offline"}
            className={cn(
              "absolute -end-0.5 -bottom-0.5 size-2 ring-2 ring-bg-primary",
              !computer.online && "border-2 border-offline bg-primary",
            )}
          />
        </TooltipTrigger>
      </Tooltip>
      <ComputerDetailInlineTitle
        key={computer.id}
        computer={computer}
        label={title}
        onUpdateDisplayName={onUpdateDisplayName}
      />
      {menu}
      <ComputerDetailPaneActions />
    </div>
  );
}
