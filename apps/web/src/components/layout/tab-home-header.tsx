import type { ReactNode } from "react";

import { PageHeader } from "#src/components/layout/page-header";
import { usePhoneShell } from "#src/components/layout/phone-shell";
import { ShellBusyAgents } from "#src/features/agents/shell-busy-agents";
import { NotificationBell } from "#src/features/usage-limits/notification-bell";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { PANE_HEADER_ATTR, PANE_HEADER_CLASS } from "#src/components/layout/pane-header";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { cx } from "#src/utils/cx";

export function TabHomeHeader({
  title,
  meta,
  agents = <ShellBusyAgents />,
  actions,
}: {
  title: string;
  meta?: ReactNode;
  agents?: ReactNode;
  actions?: ReactNode;
}) {
  const { workspaceSwitcher } = usePhoneShell();
  const workspaceSlug = useWorkspaceSlug();
  return (
    <header
      {...PANE_HEADER_ATTR}
      className={cx(
        PANE_HEADER_CLASS,
        "gap-2 bg-primary px-page [[data-phone-page-scroll]_&]:sticky [[data-phone-page-scroll]_&]:top-0 [[data-phone-page-scroll]_&]:z-20",
      )}
    >
      <span className="-ml-1.5 flex shrink-0">{workspaceSwitcher}</span>
      <h1 className="min-w-0 truncate text-lg font-semibold text-primary">{title}</h1>
      {meta}
      <div className="flex h-full min-w-0 flex-1 items-center">{agents}</div>
      <div className="flex shrink-0 items-center gap-1">
        <NotificationBell workspaceSlug={workspaceSlug} badgeRing="ring-bg-primary" />
        {actions}
      </div>
    </header>
  );
}

export function TabPageHeader({ title }: { title: string }) {
  return useBreakpoint("lg") ? (
    <PageHeader leading={null} heading={title} />
  ) : (
    <TabHomeHeader title={title} />
  );
}
