import type { ReactNode } from "react";
import { ProgressBar } from "react-aria-components";
import { Spinner } from "#src/components/ui/spinner";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#src/components/ui/empty";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

/**
 * What a stream with no rows shows: a spinner while its read is in flight, else its empty state.
 * A narrow pane (a thread, the Task popup) keeps both small and centred; the main stream sets the
 * empty state as a left-aligned heading a little way down.
 */
export function ConversationStreamPlaceholder({
  loading,
  narrow,
  emptyState,
}: {
  loading: boolean;
  narrow: boolean;
  emptyState: { title: string; description: string; media: ReactNode };
}) {
  const padding = narrow ? "px-4 py-8 md:px-6" : "px-4 pt-[clamp(2rem,10svh,5rem)] pb-8 md:px-6";
  if (loading)
    return (
      <div role="status" className={cn("flex items-center justify-center text-tertiary", padding)}>
        <ProgressBar
          isIndeterminate
          aria-label={m.conversation_loading()}
          className="inline-flex shrink-0"
        >
          <Spinner className="size-4" />
        </ProgressBar>
      </div>
    );
  return (
    <Empty className={cn(padding, !narrow && "items-start text-left")}>
      <EmptyHeader className={narrow ? "gap-2" : "w-full max-w-sm items-start gap-3"}>
        <EmptyMedia className="mb-1">{emptyState.media}</EmptyMedia>
        <EmptyTitle
          role="heading"
          aria-level={narrow ? 3 : 2}
          className={cn(
            "max-w-full [overflow-wrap:anywhere]",
            narrow ? "text-sm" : "text-xl font-semibold",
          )}
        >
          {emptyState.title}
        </EmptyTitle>
        <EmptyDescription>{emptyState.description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
