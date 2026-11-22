import { Skeleton } from "#src/components/ui/skeleton";
import * as m from "#src/paraglide/messages";

export function MemoryPending() {
  return (
    <main aria-busy="true" className="flex h-full min-h-0 flex-col bg-primary">
      <p role="status" className="sr-only">
        {m.memory_loading()}
      </p>
      <header className="flex items-center justify-between gap-4 border-b border-secondary px-5 py-4 lg:px-8">
        <Skeleton className="h-6 w-36" />
        <Skeleton className="h-9 w-28 rounded-lg" />
      </header>
      <div className="flex min-h-0 flex-1 divide-x divide-secondary motion-safe:animate-pulse">
        <div className="flex w-full flex-col gap-3 p-4 lg:w-80">
          <Skeleton className="h-9 w-full rounded-lg" />
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-16 w-full rounded-xl" />
        </div>
        <div className="hidden flex-1 flex-col gap-4 p-8 lg:flex">
          <Skeleton className="h-7 w-64" />
          <Skeleton className="h-4 w-full max-w-xl" />
          <Skeleton className="h-4 w-5/6 max-w-lg" />
          <Skeleton className="h-32 w-full max-w-xl rounded-xl" />
        </div>
      </div>
    </main>
  );
}
