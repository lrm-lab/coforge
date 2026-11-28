import type { ReactNode } from "react";

import { PageHeader } from "#src/components/layout/page-header";
import { usePhoneShell } from "#src/components/layout/phone-shell";
import { ShellBusyAgents } from "#src/features/agents/shell-busy-agents";
import { NotificationBell } from "#src/features/usage-limits/notification-bell";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { useBreakpoint } from "#src/hooks/use-breakpoint";

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
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-secondary bg-primary px-page [[data-phone-page-scroll]_&]:sticky [[data-phone-page-scroll]_&]:top-0 [[data-phone-page-scroll]_&]:z-20">
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
