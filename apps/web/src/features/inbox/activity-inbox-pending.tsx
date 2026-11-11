import { PageHeader } from "#src/components/layout/page-header";
import { TabHomeHeader } from "#src/components/layout/tab-home-header";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { Skeleton } from "#src/components/ui/skeleton";
import { m } from "#src/paraglide/messages";

/** The Activity page while its first page loads (the route's pending fallback). */
export function ActivityInboxPending() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={m.activity_inbox_loading()}
      className="flex h-full min-h-0 flex-col"
    >
      {/* The tabs' place, so the list does not move when the page lands: in the page header from
      `lg` up, in their own row under the tab home's header below it, as the loaded page has them. */}
      {useBreakpoint("lg") ? (
        <PageHeader
          leading={null}
          heading={m.navigation_activity()}
          tabs={<Skeleton className="mb-3 h-6 w-64" />}
          tabsStart
        />
      ) : (
        <>
          <TabHomeHeader title={m.navigation_activity()} />
          <div className="flex shrink-0 items-center border-b border-secondary px-page py-2">
            <Skeleton className="h-8 w-56" />
          </div>
        </>
      )}
      {/* The list's rows at their final inset and size, full width: nothing is open yet. */}
      <ol className="flex flex-col py-1">
        {[0, 1, 2, 3].map((row) => (
          <li key={row} className="flex items-center gap-3 px-page py-3">
            <Skeleton className="size-9 shrink-0 rounded-md" />
            <div className="min-w-0 flex-1">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="mt-2 h-4 w-3/4" />
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
