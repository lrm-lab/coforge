import { Skeleton } from "#src/components/ui/skeleton";

/** The profile panel's body while the Agent's profile loads: avatar, name and two blocks. */
export function AgentProfileSkeleton() {
  return (
    <div className="flex flex-col gap-4 px-5 py-5">
      <div className="flex items-center gap-4">
        <Skeleton className="size-16 shrink-0 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-20" />
        </div>
      </div>
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}
