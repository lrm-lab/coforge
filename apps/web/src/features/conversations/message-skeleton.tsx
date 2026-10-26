import { Skeleton } from "#src/components/ui/skeleton";

/**
 * One message row while the messages are read, laid out as `MessageRow` lays out a first message
 * (its margins, padding, gap and avatar column), so the loaded row takes its place without a jump.
 * `width` is the first line's; the name and the last line are the same in every row. The caller
 * animates the group, so the rows pulse together.
 */
export function MessageSkeleton({ width }: { width: string }) {
  return (
    <div className="mx-1 flex gap-3 px-3 py-3 md:mx-3">
      <div className="flex w-9 shrink-0 justify-center">
        <Skeleton className="size-8 rounded-full" />
      </div>
      <div className="min-w-0 flex-1 space-y-2.5 pt-1">
        <Skeleton className="h-3 w-24" />
        <Skeleton className={`h-3 ${width}`} />
        <Skeleton className="h-3 w-2/5" />
      </div>
    </div>
  );
}
