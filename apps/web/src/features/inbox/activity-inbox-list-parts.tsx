import { Fragment, type ReactNode, useRef } from "react";
import type { Pin01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { useEndOfList } from "#src/lib/use-end-of-list";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

export type ActivitySection = {
  key: string;
  label: string;
  heading?: string;
  icon?: typeof Pin01;
  count?: number;
  dated?: boolean;
  rows: ReactNode[];
  footer?: ReactNode;
};

export function ActivityInboxSections({ sections }: { sections: ActivitySection[] }) {
  return (
    <>
      {sections.map((section, index) => (
        <Fragment key={section.key}>
          {(section.icon || section.count !== undefined || index > 0 || section.dated) && (
            <ActivityInboxSectionHeading
              icon={section.icon}
              label={section.heading ?? section.label}
              count={section.count}
              className={cn(index > 0 && "pt-4")}
            />
          )}
          <ol
            aria-label={section.label}
            data-undated={section.dated === false ? "" : undefined}
            className="relative flex flex-col"
          >
            {section.rows}
          </ol>
          {section.footer}
        </Fragment>
      ))}
    </>
  );
}

function ActivityInboxSectionHeading({
  icon: Icon,
  label,
  count,
  className,
}: {
  icon?: typeof Pin01;
  label: string;
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
        <span className="font-normal text-quaternary tabular-nums">{count}</span>
      )}
    </h2>
  );
}

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

export function ActivityInboxActionError({
  onRetry,
  onDismiss,
}: {
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex shrink-0 items-center gap-3 border-b border-secondary px-page py-2 text-sm text-error-primary"
    >
      <span className="min-w-0 flex-1">{m.activity_inbox_action_error()}</span>
      <Button size="sm" color="link-gray" onClick={onRetry}>
        {m.activity_inbox_retry()}
      </Button>
      <Button size="sm" color="link-gray" onClick={onDismiss}>
        {m.activity_inbox_dismiss()}
      </Button>
    </div>
  );
}
