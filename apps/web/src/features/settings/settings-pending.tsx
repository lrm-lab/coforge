import { UserCircle } from "@untitledui/icons";
import { PageHeader } from "#src/components/layout/page-header";
import { Skeleton } from "#src/components/ui/skeleton";
import { m } from "#src/paraglide/messages";
import { SettingsNavigationGroup } from "./settings-navigation-group";
import { SETTINGS_SECTION_GROUPS } from "./settings-sections";

export function SettingsPending() {
  return (
    <main
      aria-busy="true"
      data-panel-cards
      className="flex h-full min-w-0 bg-primary lg:gap-2 lg:bg-transparent"
    >
      <p role="status" className="sr-only">
        {m.settings_loading()}
      </p>
      <nav className="flex w-full min-w-0 flex-col overflow-hidden border-r border-secondary bg-primary md:w-60 md:shrink-0 lg:rounded-xl lg:border-r-0">
        <PageHeader heading={m.settings_title()} />
        <div className="space-y-5 overflow-y-auto p-3">
          {SETTINGS_SECTION_GROUPS.map((group) => (
            <SettingsNavigationGroup key={group.label()} label={group.label()}>
              {group.sections.map((item) => (
                <li key={item.id} className="flex h-9 items-center gap-3 px-3 text-sm font-medium">
                  <span>{item.label()}</span>
                </li>
              ))}
            </SettingsNavigationGroup>
          ))}
        </div>
      </nav>
      <section className="@container/settings hidden min-w-0 flex-1 flex-col overflow-hidden bg-primary md:flex lg:rounded-xl">
        <PageHeader icon={UserCircle} heading={m.settings_account()} />
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto pb-8">
          <section aria-hidden="true" className="motion-safe:animate-pulse">
            <header className="flex min-w-0 items-center gap-4 px-page pt-8 sm:gap-6">
              <Skeleton className="size-24 shrink-0 rounded-2xl" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-5 w-40 max-w-full" />
                <Skeleton className="h-4 w-56 max-w-full" />
              </div>
            </header>
            <dl className="mt-8 flex max-w-2xl min-w-0 flex-col gap-6 px-page">
              {["w-3/5", "w-28", "w-4/5", "w-2/5"].map((width, index) => (
                <div key={index} className="flex min-w-0 flex-col gap-1.5">
                  <Skeleton className="h-3.5 w-20" />
                  <Skeleton className={`h-4 max-w-full ${width}`} />
                </div>
              ))}
            </dl>
          </section>
        </div>
      </section>
    </main>
  );
}
