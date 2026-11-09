import { useRef } from "react";
import type { Pin01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { useEndOfList } from "#src/lib/use-end-of-list";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

/** A list section's label (Pinned, All conversations): a tertiary subheading on the rows' inset,
 * with the section's mark when it has one. */
export function ActivityInboxSectionHeading({
  icon: Icon,
  label,
  count,
  className,
}: {
  icon?: typeof Pin01;
  label: string;
  /** How many the section holds, after its label. */
  count?: number;
  className?: string;
}) {
  return (
    <h2
      className={cn(
        "flex items-center gap-1.5 px-page pt-2 pb-1 text-sm font-medium text-tertiary",
        className,
      )}
    >
      {Icon && <Icon aria-hidden="true" className="size-3 shrink-0 text-fg-quaternary" />}
      {label}
      {count !== undefined && (
        <span className="font-normal text-quaternary tabular-nums">
          <span aria-hidden="true">· </span>
          {count}
        </span>
      )}
    </h2>
  );
}

/**
 * Asks for the next page as the end of the list scrolls into view. A failed page stops asking and
 * offers a retry instead, so a broken request is never repeated in a loop.
 */
export function ActivityInboxLoadMore({
  hasNextPage,
  isFetchingNextPage,
  failed,
  fetchNextPage,
}: {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  failed: boolean;
  fetchNextPage: () => Promise<unknown>;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  useEndOfList(sentinel, hasNextPage && !isFetchingNextPage && !failed, () => void fetchNextPage());
  if (!hasNextPage) return null;
  return (
    <div ref={sentinel} className="flex items-center justify-center gap-2 py-3 text-xs">
      {failed ? (
        <>
          <span className="text-error-primary">{m.activity_inbox_load_more_error()}</span>
          <Button size="sm" color="link-gray" onClick={() => void fetchNextPage()}>
            {m.activity_inbox_retry()}
          </Button>
        </>
      ) : isFetchingNextPage ? (
        <span className="text-tertiary">{m.activity_inbox_loading_more()}</span>
      ) : null}
    </div>
  );
}
