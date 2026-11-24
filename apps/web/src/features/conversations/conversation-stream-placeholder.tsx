import type { ReactNode } from "react";
import { ProgressBar } from "react-aria-components";
import { Spinner } from "#src/components/ui/spinner";
import { EmptyState } from "#src/components/ui/empty";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

export function ConversationStreamPlaceholder({
  loading,
  narrow,
  emptyState,
}: {
  loading: boolean;
  narrow: boolean;
  emptyState: {
    title: string;
    description: string;
    media: ReactNode;
    singleLineDescription?: boolean;
  };
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
    <EmptyState
      headingLevel={narrow ? 3 : 2}
      picture={emptyState.media}
      title={emptyState.title}
      description={emptyState.description}
      className={cn(
        padding,
        !narrow && "mx-0 items-start text-left [&>p]:text-left",
        emptyState.singleLineDescription && "max-w-none text-wrap [&>p]:max-w-none",
      )}
    />
  );
}
