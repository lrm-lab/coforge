import { Plus, SearchLg as Search, UsersPlus } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { PageBackButton } from "#src/components/layout/page-back-button";
import { PANE_HEADER_ATTR, PANE_HEADER_CLASS } from "#src/components/layout/pane-header";
import { Skeleton } from "#src/components/ui/skeleton";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";

export function AgentsPending() {
  return (
    <main className="flex h-full min-w-0">
      <section className="@container/members flex min-w-0 flex-1 flex-col overflow-hidden bg-primary">
        <header {...PANE_HEADER_ATTR} className={cx(PANE_HEADER_CLASS, "gap-3 px-page")}>
          <PageBackButton />
          <h1 className="truncate text-lg font-semibold text-primary">
            {m.member_directory_title()}
          </h1>
          <Skeleton aria-hidden="true" className="hidden h-4 w-36 rounded-sm sm:block" />
        </header>

        <div className="flex shrink-0 flex-wrap items-center gap-2.5 px-page pt-4 pb-3">
          <div
            aria-hidden="true"
            className="flex shrink-0 items-center gap-1 rounded-lg bg-secondary_alt p-1 ring-1 ring-secondary ring-inset"
          >
            {[m.member_tab_all(), m.member_tab_humans(), m.member_tab_agents()].map((label) => (
              <span
                key={label}
                className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm font-semibold text-quaternary"
              >
                {label}
                <Skeleton className="h-3.5 w-4 rounded-sm" />
              </span>
            ))}
          </div>
          <Input
            type="search"
            size="sm"
            icon={Search}
            aria-label={m.member_search_all()}
            placeholder={m.member_search_all()}
            isDisabled
            className="min-w-[12rem] flex-1"
          />
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" color="secondary" iconLeading={UsersPlus} isDisabled>
              {m.member_invite_humans()}
            </Button>
            <Button size="sm" color="primary" iconLeading={Plus} isDisabled>
              {m.header_new_agent()}
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-page pt-2 pb-8">
          <p role="status" className="sr-only">
            {m.agents_loading()}
          </p>
          <section
            aria-busy="true"
            aria-label={m.navigation_agents()}
            className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(min(100%,14rem),1fr))]"
          >
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <div
                key={index}
                aria-hidden="true"
                className="flex min-w-0 items-center gap-3 rounded-xl bg-primary px-3.5 py-3 ring-1 ring-secondary ring-inset"
              >
                <Skeleton className="size-10 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
            ))}
          </section>
        </div>
      </section>
    </main>
  );
}
