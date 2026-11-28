import {
  PANE_HEADER_ATTR,
  PANE_HEADER_CLASS,
  PANE_SUBBAR_ATTR,
  PANE_SUBBAR_CLASS,
} from "#src/components/layout/pane-header";
import { TabHomeHeader } from "#src/components/layout/tab-home-header";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { Skeleton } from "#src/components/ui/skeleton";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";

export function ActivityInboxPending() {
  const desktop = useBreakpoint("lg");
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={m.activity_inbox_loading()}
      className="flex h-full min-h-0 min-w-0"
    >
      <div className="flex min-h-0 flex-1 flex-col bg-primary lg:w-list-column lg:flex-none lg:shrink-0">
        {desktop ? (
          <header {...PANE_HEADER_ATTR} className={cx(PANE_HEADER_CLASS, "gap-2 px-4")}>
            <h1 className="truncate text-lg font-semibold text-primary">
              {m.navigation_activity()}
            </h1>
            <Skeleton className="h-8 w-16 rounded-md" />
          </header>
        ) : (
          <>
            <TabHomeHeader title={m.navigation_activity()} />
            <div {...PANE_SUBBAR_ATTR} className={cx(PANE_SUBBAR_CLASS, "px-4")}>
              <Skeleton className="h-5 w-52" />
            </div>
          </>
        )}
        <ol className="flex flex-col gap-0.5 px-1.5 py-2">
          {[0, 1, 2, 3].map((row) => (
            <li key={row} className="flex items-center gap-3 rounded-lg px-2.5 py-2.5">
              <Skeleton className="size-8 shrink-0 rounded-md" />
              <div className="min-w-0 flex-1">
                <Skeleton className="h-5 w-2/5" />
                <Skeleton className="mt-1.5 h-4 w-4/5" />
              </div>
            </li>
          ))}
        </ol>
      </div>
      {desktop && <div className="min-h-0 min-w-0 flex-1 border-s border-secondary bg-primary" />}
    </div>
  );
}
