import type { ReactNode } from "react";

import { computerIcon, type ComputerIdentity } from "./computer-identity";
import { BackToComputers, ComputerDetailPaneActions } from "./back-to-computers";

export function ComputerDetailHeader({
  computer,
  title,
  menu,
}: {
  computer: ComputerIdentity;
  title: string;
  menu?: ReactNode;
}) {
  const Icon = computerIcon(computer);

  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-secondary px-page">
      <BackToComputers />
      <span
        aria-hidden="true"
        className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-secondary bg-secondary_subtle text-tertiary"
      >
        <Icon className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-primary">{title}</span>
      {menu}
      <ComputerDetailPaneActions />
    </div>
  );
}
