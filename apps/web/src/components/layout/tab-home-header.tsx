import type { ReactNode } from "react";

import { usePhoneShell } from "#src/components/layout/phone-shell";
import { PhoneBusyAgents } from "#src/features/agents/shell-busy-agents";
import { NotificationBell } from "#src/features/usage-limits/notification-bell";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";

/**
 * The header every tab home shows on a phone, below `lg`: the CoForge mark that opens the
 * Workspace switcher, the page's title, the busy Agents filling the space after it, and the
 * notification bell. `actions` follow the bell (Chat's "new conversation"). A desktop has the top
 * bar instead.
 */
export function TabHomeHeader({
  title,
  meta,
  agents = <PhoneBusyAgents />,
  actions,
}: {
  title: string;
  /** Status that belongs beside the title (Chat's connection state). */
  meta?: ReactNode;
  /** The busy Agents; Chat ranks the ones it has a Direct message with. */
  agents?: ReactNode;
  actions?: ReactNode;
}) {
  const { workspaceSwitcher } = usePhoneShell();
  const workspaceSlug = useWorkspaceSlug();
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-secondary px-page lg:hidden">
      <span className="-ml-1.5 flex shrink-0">{workspaceSwitcher}</span>
      <h1 className="min-w-0 truncate text-lg font-semibold text-primary">{title}</h1>
      {meta}
      <div className="flex h-full min-w-0 flex-1 items-center">{agents}</div>
      <div className="flex shrink-0 items-center gap-1">
        <NotificationBell workspaceSlug={workspaceSlug} />
        {actions}
      </div>
    </header>
  );
}
