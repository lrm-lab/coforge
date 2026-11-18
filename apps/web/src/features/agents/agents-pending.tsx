import { Plus, SearchLg as Search } from "@untitledui/icons";
import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { PageBackButton } from "#src/components/layout/page-back-button";
import { PaneHeader } from "#src/components/layout/pane-header";
import { Skeleton } from "#src/components/ui/skeleton";
import { m } from "#src/paraglide/messages";

export function AgentsPending() {
  return (
    <main className="flex h-full min-w-0">
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-primary">
        <PaneHeader
          className="px-page"
          bar={
            <div aria-hidden="true" className="flex gap-6">
              {[m.member_tab_agents(), m.member_tab_humans()].map((label) => (
                <span
                  key={label}
                  className="flex items-center gap-1 px-0.5 pb-2.5 text-sm font-semibold text-quaternary"
                >
                  {label}
                  <Skeleton className="h-4 w-6 rounded-full" />
                </span>
              ))}
            </div>
          }
        >
          <PageBackButton />
          <h1 className="min-w-0 flex-1 truncate text-lg font-semibold text-primary">
            {m.member_directory_title()}
          </h1>
          <Button size="sm" color="primary" iconLeading={Plus} isDisabled>
            {m.header_new_agent()}
          </Button>
        </PaneHeader>
        <div className="flex shrink-0 flex-wrap items-center gap-3 px-page pt-5">
          <Skeleton aria-hidden="true" className="h-9 w-32 rounded-lg" />
          <Input
            type="search"
            size="sm"
            icon={Search}
            aria-label={m.member_search_agents()}
            placeholder={`${m.member_search_agents()}...`}

            isDisabled
            className="w-full sm:w-80"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-page pb-8">
          <p role="status" className="sr-only">
            {m.agents_loading()}
          </p>
          <section
            aria-busy="true"
            aria-label={m.navigation_agents()}
            className="mt-4 grid gap-4 md:grid-cols-[repeat(auto-fill,minmax(26rem,1fr))]"
          >
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <div
                key={index}
                aria-hidden="true"
                className="flex min-h-48 min-w-0 flex-col rounded-xl bg-primary p-4 ring-1 ring-secondary ring-inset"
              >
                <div className="flex flex-1 flex-col gap-2.5 motion-safe:animate-pulse">
                  <div className="flex items-start justify-between">
                    <Skeleton className="size-12 shrink-0 rounded-full" />
                    <Skeleton className="h-9 w-16 rounded-lg" />
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <Skeleton className="h-4 w-2/5" />
                      <Skeleton className="h-5 w-24 rounded-full" />
                    </div>
                    <Skeleton className="h-3 w-1/4" />
                  </div>
                  <div className="space-y-2">
                    <Skeleton className="h-3.5 w-full" />
                    <Skeleton className="h-3.5 w-2/3" />
                  </div>
                  <div className="mt-auto flex items-center gap-4 pt-1">
                    <Skeleton className="size-6 rounded-full" />
                    <Skeleton className="h-3 w-1/4" />
                    <Skeleton className="h-3 w-1/4" />
                  </div>
                </div>
              </div>
            ))}
          </section>
        </div>
      </section>
    </main>
  );
}
