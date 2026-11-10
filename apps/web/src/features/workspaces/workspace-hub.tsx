import { PageHeader } from "#src/components/layout/page-header";
import { usePhoneShell } from "#src/components/layout/phone-shell";
import { ShellLinks } from "#src/components/layout/shell-links";
import { TabHomeHeader } from "#src/components/layout/tab-home-header";
import { TabPageRow } from "#src/components/layout/tab-page-row";
import { m } from "#src/paraglide/messages";

/**
 * The phone's Workspace tab: the sidebar's own items under Chat and Activity (AI Workbench when
 * on, Projects, Members, Records, Computers), from the same list the sidebar is drawn from. A
 * desktop has the sidebar and links nowhere here; the page is a plain list there.
 */
export function WorkspaceHub() {
  const { workspaceItems } = usePhoneShell();
  return (
    <ShellLinks>
      <div className="flex min-h-0 flex-1 flex-col">
        <TabHomeHeader title={m.navigation_workspace_group()} />
        <div className="max-lg:hidden">
          <PageHeader leading={null} heading={m.navigation_workspace_group()} />
        </div>
        <ul className="min-h-0 flex-1 divide-y divide-secondary overflow-y-auto lg:max-w-2xl">
          {workspaceItems.map((item) => (
            <TabPageRow
              key={item.label}
              icon={item.icon}
              label={item.label}
              href={item.href}
              badge={item.badge}
            />
          ))}
        </ul>
      </div>
    </ShellLinks>
  );
}
